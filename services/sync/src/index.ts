/**
 * Hand-rolled Yjs sync relay, multi-node (Week 4).
 *
 * Implements the y-websocket wire protocol (y-protocols) so y-websocket clients work:
 *   on connect the server sends [sync, step1(stateVector)] and [sync, step2(fullState)];
 *   client step2 / update frames are applied with the client socket as origin;
 *   awareness frames ([1, ...]) are applied and relayed.
 *
 * Origins and what happens to an applied doc update (one place: onDocUpdate):
 *   WebSocket (a local client) | "ai-accept" | "server"  -> LOCAL:
 *        broadcast to local clients (except the sender), publish once to Redis,
 *        mark dirty + reset idle-index timer.
 *   "redis" | "redis-sync" | "db-merge" | "db-load"        -> REMOTE/APPLIED:
 *        broadcast to local clients only. Never re-published, never marks dirty.
 *
 * Room lifecycle:
 *   - getRoom() stores ONE Promise per room while it loads, so concurrent callers all
 *     await the same load (Task 0). A load = subscribe to Redis channels, apply the
 *     Postgres state, then cold-start sync with peers (wait <= 300ms for a reply).
 *   - Websocket messages that arrive while the room is loading are buffered, not lost.
 *   - After the last local client leaves: save under lock (force merge check), then
 *     unload + unsubscribe after ROOM_UNLOAD_GRACE_MS unless someone rejoined.
 */

import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import Redis from "ioredis";
import * as urlModule from "url";
import { authenticateSocket } from "./socketAuth";
import { wholeLineOccurrences } from "./rangeMatch";
import { NODE_ID, PORT, log, logErr } from "./node";
import {
  initRelay,
  subscribeRoom,
  unsubscribeRoom,
  coldStartSync,
  publishUpdate,
  publishAwareness,
  stats as relayStats,
  redisPub,
  ORIGIN_REDIS,
} from "./relay";
import {
  loadRoomPersistence,
  saveRoomPersistence,
  markRoomDirty,
  startPeriodicPersistence,
  forgetRoomMeta,
  getRoomMeta,
  persistStats,
} from "./persistence";

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "codesync-internal-ai-secret";
const ROOM_UNLOAD_GRACE_MS = Number(process.env.ROOM_UNLOAD_GRACE_MS ?? 30000);
const startedAt = Date.now();

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// y-protocols/sync sub-types: step1 = request (read), step2 / update = write.
const SYNC_STEP1 = 0;
/** Document writes dropped because the sender's role is VIEWER (plan step 2.5). */
const viewerStats = { droppedUpdates: 0 };

/** Origin used when a disconnecting client's awareness is removed (published). */
const ORIGIN_CLIENT_CLOSE = "client-close";
const LOCAL_STRING_ORIGINS = new Set(["ai-accept", "server"]);

interface RoomState {
  roomId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  /** awareness clientIDs controlled by each local socket */
  controlledIds: Map<WebSocket, Set<number>>;
  unloadTimer: NodeJS.Timeout | null;
}

const rooms = new Map<string, RoomState>(); // fully loaded
const loadingRooms = new Map<string, RoomState>(); // loading (relay may apply into these)
const roomLoads = new Map<string, Promise<RoomState>>();

const encodeUpdateMsg = (update: Uint8Array) => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_SYNC);
  syncProtocol.writeUpdate(e, update);
  return encoding.toUint8Array(e);
};

const encodeAwarenessMsg = (awarenessUpdate: Uint8Array) => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(e, awarenessUpdate);
  return encoding.toUint8Array(e);
};

const send = (ws: WebSocket, data: Uint8Array) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(data, (err) => err && ws.terminate());
};

function createRoomState(roomId: string): RoomState {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // the server itself has no presence
  const state: RoomState = {
    roomId,
    doc,
    awareness,
    clients: new Set(),
    controlledIds: new Map(),
    unloadTimer: null,
  };

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const isLocal = origin instanceof WebSocket || (typeof origin === "string" && LOCAL_STRING_ORIGINS.has(origin));
    const msg = encodeUpdateMsg(update);
    state.clients.forEach((c) => {
      if (c !== origin) send(c, msg);
    });
    if (isLocal) {
      void publishUpdate(roomId, update);
      markRoomDirty(roomId, doc);
    }
  });

  awareness.on("update", ({ added, updated, removed }: any, origin: unknown) => {
    const changed: number[] = added.concat(updated, removed);
    if (origin instanceof WebSocket) {
      const ids = state.controlledIds.get(origin);
      if (ids) {
        added.forEach((id: number) => ids.add(id));
        updated.forEach((id: number) => ids.add(id));
        removed.forEach((id: number) => ids.delete(id));
      }
    }
    const buf = awarenessProtocol.encodeAwarenessUpdate(awareness, changed);
    // Sent to every local client, including the sender: like the reference
    // y-websocket server, this keeps a lone client's connection from idling out.
    const msg = encodeAwarenessMsg(buf);
    state.clients.forEach((c) => send(c, msg));
    if (origin instanceof WebSocket || origin === ORIGIN_CLIENT_CLOSE) void publishAwareness(roomId, buf);
    // origin "redis" (peer) and "timeout" (outdated state expiry) are not re-published.
  });

  return state;
}

/** Task 0: one load Promise per room; every concurrent caller awaits the same load. */
function getRoom(roomId: string): Promise<RoomState> {
  const loaded = rooms.get(roomId);
  if (loaded) return Promise.resolve(loaded);
  const inflight = roomLoads.get(roomId);
  if (inflight) return inflight;

  const p = (async () => {
    const state = createRoomState(roomId);
    loadingRooms.set(roomId, state);
    try {
      await subscribeRoom(roomId); // before loading, so concurrent peer edits are not missed
      await loadRoomPersistence(roomId, state.doc);
      const gotReply = await coldStartSync(roomId, state.doc);
      log(`Room ${roomId} loaded (peer reply within wait: ${gotReply})`);
      rooms.set(roomId, state);
      return state;
    } finally {
      loadingRooms.delete(roomId);
      roomLoads.delete(roomId);
    }
  })();
  roomLoads.set(roomId, p);
  return p;
}

const lookupRoom = (roomId: string) => {
  const s = rooms.get(roomId) ?? loadingRooms.get(roomId);
  if (!s) return undefined;
  return {
    doc: s.doc,
    applyRemoteAwareness: (u: Uint8Array) => awarenessProtocol.applyAwarenessUpdate(s.awareness, u, ORIGIN_REDIS),
  };
};

initRelay(lookupRoom, () => [...rooms.keys()]);
startPeriodicPersistence(rooms);

function scheduleUnload(state: RoomState) {
  if (state.unloadTimer) clearTimeout(state.unloadTimer);
  state.unloadTimer = setTimeout(async () => {
    state.unloadTimer = null;
    if (state.clients.size > 0 || rooms.get(state.roomId) !== state) return;
    const r = await saveRoomPersistence(state.roomId, state.doc, { force: true });
    if (state.clients.size > 0) return; // someone rejoined during the save
    if (r === "error" || r === "lock-busy") {
      scheduleUnload(state); // keep it in memory and try again later
      return;
    }
    rooms.delete(state.roomId);
    await unsubscribeRoom(state.roomId);
    forgetRoomMeta(state.roomId, state.doc);
    state.awareness.destroy();
    state.doc.destroy();
    log(`Room ${state.roomId} unloaded after ${ROOM_UNLOAD_GRACE_MS}ms grace`);
  }, ROOM_UNLOAD_GRACE_MS);
}

/** HTTP callers load rooms without a websocket; let those unload after the grace too. */
async function getRoomForHttp(roomId: string) {
  const state = await getRoom(roomId);
  if (state.clients.size === 0) scheduleUnload(state);
  return state;
}

const totalClients = () => {
  let n = 0;
  rooms.forEach((r) => (n += r.clients.size));
  return n;
};

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = urlModule.parse(req.url || "", true);
  const pathname = parsedUrl.pathname || "";
  const secretHeader =
    req.headers["x-internal-secret"] ||
    (typeof req.headers["authorization"] === "string" ? req.headers["authorization"].replace(/^Bearer\s+/i, "") : null);
  const authed = !!secretHeader && secretHeader === INTERNAL_SECRET;

  // Public liveness/identity endpoint (Task 1). Per-room detail only with the secret.
  if (req.method === "GET" && pathname === "/health") {
    const body: Record<string, unknown> = {
      ok: true,
      nodeId: NODE_ID,
      rooms: rooms.size,
      clients: totalClients(),
      redis: redisPub.status,
      uptimeMs: Date.now() - startedAt,
      relay: relayStats,
      persistence: persistStats,
      viewer: viewerStats,
      control: controlStats,
    };
    if (authed) {
      const roomDetails: Record<string, { clients: number }> = {};
      rooms.forEach((r, id) => (roomDetails[id] = { clients: r.clients.size }));
      body.roomDetails = roomDetails;
    }
    return json(res, 200, body);
  }

  if (!authed) return json(res, 401, { error: "Unauthorized: missing or invalid internal secret" });

  // GET /room/:roomId/state
  const stateMatch = pathname.match(/^\/room\/([^\/\?]+)\/state$/);
  if (req.method === "GET" && stateMatch) {
    try {
      const roomId = decodeURIComponent(stateMatch[1]);
      const room = await getRoomForHttp(roomId);
      const meta = getRoomMeta(roomId);
      return json(res, 200, {
        roomId,
        stateVector: Buffer.from(Y.encodeStateVector(room.doc)).toString("base64"),
        content: room.doc.getText("content").toString(),
        fileId: meta?.fileId,
        path: meta?.path,
        language: meta?.language,
        nodeId: NODE_ID,
      });
    } catch (err: any) {
      logErr("Error getting room state:", err);
      return json(res, 500, { error: err.message });
    }
  }

  // POST /room/:roomId/apply-patch  (the Accept flow; exactly-once range check)
  const patchMatch = pathname.match(/^\/room\/([^\/\?]+)\/apply-patch$/);
  if (req.method === "POST" && patchMatch) {
    try {
      const roomId = decodeURIComponent(patchMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const { startOffset, deleteLength, newCode, oldRangeText } = body;
      const room = await getRoomForHttp(roomId);
      const ytext = room.doc.getText("content");
      const offset = typeof startOffset === "number" ? startOffset : -1;
      const len = typeof deleteLength === "number" ? deleteLength : oldRangeText ? oldRangeText.length : 0;

      const txStatus: { error: { status: number; message: string } | null } = { error: null };
      room.doc.transact(() => {
        const currentText = ytext.toString();
        if (oldRangeText) {
          const matches = wholeLineOccurrences(currentText, oldRangeText);
          const occurrences = matches.length;
          if (occurrences === 0) {
            txStatus.error = { status: 409, message: "Target code range not found in current document" };
            return;
          }
          if (occurrences > 1) {
            txStatus.error = {
              status: 409,
              message: "Target code range is ambiguous (found multiple times in current document)",
            };
            return;
          }
          const actualOffset = matches[0];
          ytext.delete(actualOffset, oldRangeText.length);
          if (newCode && newCode.length > 0) ytext.insert(actualOffset, newCode);
        } else {
          if (offset < 0 || offset > currentText.length) {
            txStatus.error = { status: 409, message: "Invalid offset or target text not found in current doc" };
            return;
          }
          if (len > 0) ytext.delete(offset, len);
          if (newCode && newCode.length > 0) ytext.insert(offset, newCode);
        }
      }, "ai-accept");

      if (txStatus.error) return json(res, txStatus.error.status, { error: txStatus.error.message });
      return json(res, 200, {
        success: true,
        content: ytext.toString(),
        stateVector: Buffer.from(Y.encodeStateVector(room.doc)).toString("base64"),
        nodeId: NODE_ID,
      });
    } catch (err: any) {
      logErr("Error handling apply-patch:", err);
      return json(res, 400, { error: err.message });
    }
  }

  // GET /room/:roomId/text
  const textMatch = pathname.match(/^\/room\/([^\/\?]+)\/text$/);
  if (req.method === "GET" && textMatch) {
    try {
      const roomId = decodeURIComponent(textMatch[1]);
      const room = await getRoomForHttp(roomId);
      return json(res, 200, { roomId, content: room.doc.getText("content").toString(), nodeId: NODE_ID });
    } catch (err: any) {
      return json(res, 500, { error: err.message });
    }
  }

  res.writeHead(200);
  res.end("CodeSync Sync Service");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (request, socket, head) => {
  try {
    // authenticateSocket verifies the Clerk token AND roomMember on every connection
    const authInfo = await authenticateSocket(request);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, authInfo);
    });
  } catch (err) {
    log(`Socket auth failed: ${(err as Error).message}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});

// ── Permission changes (role changed / member removed) ─────────────────────
// Roles are checked when a socket connects. When the API changes a member's role or
// removes them it publishes {roomId, userId} on SYNC_CONTROL_CHANNEL; every node closes
// that user's sockets in that room (code 4001). y-websocket reconnects at once and the
// upgrade handler checks the NEW role (or refuses a removed member).
export const SYNC_CONTROL_CHANNEL = "sync:control";
const socketOwners = new Map<WebSocket, { userId: string; roomId: string }>();
export const controlStats = { reauthRequests: 0, socketsClosedForReauth: 0 };
const control = new Redis(process.env.REDIS_URL || "redis://localhost:6380", { maxRetriesPerRequest: null });
control.on("error", () => {});
control.subscribe(SYNC_CONTROL_CHANNEL).catch((err) => logErr("control channel subscribe failed:", err));
control.on("message", (channel, raw) => {
  if (channel !== SYNC_CONTROL_CHANNEL) return;
  let msg: { type?: string; roomId?: string; userId?: string };
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type !== "reauth" || !msg.roomId || !msg.userId) return;
  controlStats.reauthRequests++;
  socketOwners.forEach((owner, ws) => {
    if (owner.roomId === msg.roomId && owner.userId === msg.userId) {
      controlStats.socketsClosedForReauth++;
      ws.close(4001, "permissions changed");
    }
  });
});

function handleTerminal(ws: WebSocket, roomId: string, jobId: string | undefined) {
  if (!jobId) {
    ws.close(4000, "Missing jobId for terminal");
    return;
  }
  log(`Terminal client connected for room ${roomId}, job ${jobId}`);
  const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6380");
  subscriber.on("error", () => {});
  const channel = `room:${roomId}:execution:${jobId}`;
  subscriber.subscribe(channel, (err) => {
    if (err) {
      logErr(`Failed to subscribe to channel ${channel}:`, err);
      ws.close();
    }
  });
  subscriber.on("message", (ch, msg) => {
    if (ch === channel && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
  const cleanup = () => {
    subscriber.unsubscribe(channel).catch(() => {});
    subscriber.quit().catch(() => {});
  };
  ws.on("close", () => {
    log(`Terminal client disconnected for job ${jobId}`);
    cleanup();
  });
  ws.on("error", cleanup);
}

wss.on("connection", (ws: WebSocket, request: http.IncomingMessage, clientInfo: { userId: string; roomId: string; role: string }) => {
  const { roomId, userId, role } = clientInfo;
  const readOnly = role === "VIEWER";
  const parsedUrl = urlModule.parse(request.url || "", true);
  if (parsedUrl.query.mode === "terminal") {
    handleTerminal(ws, roomId, parsedUrl.query.jobId as string | undefined);
    return;
  }

  log(`Connection from user ${userId} for room ${roomId}`);
  socketOwners.set(ws, { userId, roomId });
  ws.on("error", (err) => logErr(`socket error (${userId}):`, err.message));

  // Buffer frames until the room is loaded so nothing the client sends early is lost.
  let room: RoomState | null = null;
  const pending: Uint8Array[] = [];
  let closed = false;

  const handleFrame = (data: Uint8Array) => {
    if (!room) return;
    try {
      const decoder = decoding.createDecoder(data);
      const msgType = decoding.readVarUint(decoder);
      if (msgType === MESSAGE_SYNC) {
        // Viewers may read (step1 -> we answer with step2) but never write: their
        // step2/update frames are dropped here, whatever the client UI does.
        if (readOnly && decoding.peekVarUint(decoder) !== SYNC_STEP1) {
          viewerStats.droppedUpdates++;
          return;
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        // Applies step2/update frames with `ws` as origin -> onDocUpdate relays them.
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
        if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
      } else if (msgType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
      }
    } catch (err) {
      logErr("message error:", err);
    }
  };

  ws.on("message", (raw: Buffer) => {
    const data = new Uint8Array(raw);
    if (room) handleFrame(data);
    else pending.push(data);
  });

  ws.on("close", () => {
    closed = true;
    socketOwners.delete(ws);
    if (!room) return;
    const r = room;
    r.clients.delete(ws);
    const ids = Array.from(r.controlledIds.get(ws) ?? []);
    r.controlledIds.delete(ws);
    // Task 5: removal goes to local peers and over Redis (origin client-close).
    if (ids.length > 0) awarenessProtocol.removeAwarenessStates(r.awareness, ids, ORIGIN_CLIENT_CLOSE);
    log(`Client ${userId} left room ${roomId} (${r.clients.size} connected)`);
    if (r.clients.size === 0) {
      log(`Room ${roomId} has no local clients; saving under lock`);
      saveRoomPersistence(roomId, r.doc, { force: true })
        .catch((err) => logErr(`save on last leave failed for ${roomId}:`, err))
        .finally(() => {
          if (r.clients.size === 0) scheduleUnload(r);
        });
    }
  });

  getRoom(roomId)
    .then((r) => {
      if (closed) {
        if (r.clients.size === 0) scheduleUnload(r);
        return;
      }
      room = r;
      if (r.unloadTimer) {
        clearTimeout(r.unloadTimer);
        r.unloadTimer = null;
      }
      r.clients.add(ws);
      r.controlledIds.set(ws, new Set());
      log(`Client ${userId} joined room ${roomId} (${r.clients.size} connected)`);

      const e1 = encoding.createEncoder();
      encoding.writeVarUint(e1, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(e1, r.doc);
      send(ws, encoding.toUint8Array(e1));

      const e2 = encoding.createEncoder();
      encoding.writeVarUint(e2, MESSAGE_SYNC);
      syncProtocol.writeSyncStep2(e2, r.doc);
      send(ws, encoding.toUint8Array(e2));

      const states = [...r.awareness.getStates().keys()];
      if (states.length > 0) send(ws, encodeAwarenessMsg(awarenessProtocol.encodeAwarenessUpdate(r.awareness, states)));

      pending.splice(0).forEach(handleFrame);
    })
    .catch((err) => {
      logErr(`Failed to load room ${roomId}:`, err);
      ws.close(1011, "room load failed");
    });
});

const handleShutdown = async (signal: string) => {
  log(`Received ${signal}. Saving all rooms to Postgres...`);
  for (const [roomId, room] of rooms.entries()) {
    await saveRoomPersistence(roomId, room.doc, { force: true }).catch(() => {});
  }
  process.exit(0);
};
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

server.listen(PORT, () => log(`Sync service running on :${PORT}`));

export { server, rooms, getRoom };
