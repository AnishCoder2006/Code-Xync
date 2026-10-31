/**
 * Hand-rolled Yjs sync relay.
 *
 * Implements the y-websocket wire protocol so that y-websocket clients
 * (used in Editor.tsx) work correctly:
 *
 *   Sync Step 1 (server → client on connect):
 *     [messageType=0, syncStep1, stateVector]
 *   Sync Step 2 (client → server after step 1):
 *     [messageType=0, syncStep2, update]
 *   Update (broadcast):
 *     [messageType=0, syncStep2, update]
 *   Awareness (pass-through):
 *     [messageType=1, …]
 *
 * Message type byte layout (matches y-websocket/src/lib.js):
 *   byte 0 = messageType  (0 = sync, 1 = awareness, 2 = auth)
 *   byte 1 = syncType     (0 = step1, 1 = step2/update)  — only when messageType=0
 *
 * Clients are tracked per-room so broadcasts never leak across rooms.
 *
 * Reconnect: a newly connecting client sends syncStep1, the server responds
 * with its current state vector + a full state update (step2). This is how
 * y-websocket handles reconnect-and-catch-up natively.
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
import {
  loadRoomPersistence,
  saveRoomPersistence,
  markRoomDirty,
  startPeriodicPersistence,
} from "./persistence";

const port = Number(process.env.SYNC_PORT ?? 4001);

// Per-room state
interface RoomState {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
}

const rooms = new Map<string, RoomState>();

const getRoom = async (roomId: string): Promise<RoomState> => {
  let room = rooms.get(roomId);
  if (!room) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    room = { doc, awareness, clients: new Set() };
    rooms.set(roomId, room);

    // Load Yjs document state from Postgres
    await loadRoomPersistence(roomId, doc);

    // Track dirty state and debounced idle indexing events on any doc updates
    doc.on("update", () => {
      markRoomDirty(roomId, doc);
    });
  }
  return room;
};

// Start 10s periodic persistence timer
startPeriodicPersistence(rooms);

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * Encode a sync message (step1 or step2/update).
 * syncType: 0 = step1 (stateVector), 1 = step2 (update)
 */
const encodeSyncStep1 = (doc: Y.Doc): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
};

const encodeSyncStep2 = (doc: Y.Doc, encodedStateVector?: Uint8Array): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, encodedStateVector);
  return encoding.toUint8Array(encoder);
};

const encodeAwarenessUpdate = (awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
};

/** Broadcast a message to all clients in a room except the sender. */
const broadcastToRoom = (roomState: RoomState, sender: WebSocket, data: Uint8Array) => {
  roomState.clients.forEach((client) => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
};

const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("CodeSync Sync Service");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (request, socket, head) => {
  try {
    // authenticateSocket verifies Clerk token AND roomMember on every connection
    const authInfo = await authenticateSocket(request);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, authInfo);
    });
  } catch (err) {
    console.error("Socket auth failed:", (err as Error).message);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});

// Track which awareness clientIDs belong to each socket
const controlledIds = new Map<WebSocket, Set<number>>();

wss.on(
  "connection",
  async (ws: WebSocket, request: http.IncomingMessage, clientInfo: { userId: string; roomId: string }) => {
    const { roomId } = clientInfo;
    const parsedUrl = urlModule.parse(request.url || "", true);
    const mode = parsedUrl.query.mode as string | undefined;

    if (mode === "terminal") {
      const jobId = parsedUrl.query.jobId as string | undefined;
      if (!jobId) {
        ws.close(4000, "Missing jobId for terminal");
        return;
      }

      console.log(`[sync] Terminal client connected for room ${roomId}, job ${jobId}`);
      const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6380");
      const channel = `room:${roomId}:execution:${jobId}`;

      subscriber.subscribe(channel, (err) => {
        if (err) {
          console.error(`[sync] Failed to subscribe to channel ${channel}:`, err);
          ws.close();
        }
      });

      subscriber.on("message", (ch, msg) => {
        if (ch === channel && ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      });

      const cleanup = () => {
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.quit().catch(() => {});
      };

      ws.on("close", () => {
        console.log(`[sync] Terminal client disconnected for job ${jobId}`);
        cleanup();
      });

      ws.on("error", (err) => {
        console.error(`[sync] Terminal client error for job ${jobId}:`, err);
        cleanup();
      });

      return;
    }

    const room = await getRoom(roomId);
    room.clients.add(ws);
    console.log(`[sync] Client ${clientInfo.userId} joined room ${roomId} (${room.clients.size} connected)`);

    controlledIds.set(ws, new Set());
    const onAwarenessUpdate = ({ added, updated, removed }: any, origin: any) => {
      if (origin === ws) {
        const ids = controlledIds.get(ws)!;
        added.forEach((id: number) => ids.add(id));
        updated.forEach((id: number) => ids.add(id));
        removed.forEach((id: number) => ids.delete(id));
      }
    };
    room.awareness.on("update", onAwarenessUpdate);

    // ── Sync Step 1: send our state vector so the client can reply with missing updates ──
    ws.send(encodeSyncStep1(room.doc));

    // ── Sync Step 2: send full current state so reconnecting clients catch up ──
    ws.send(encodeSyncStep2(room.doc));

    // ── Send current awareness state ──
    const awarenessClients = [...room.awareness.getStates().keys()];
    if (awarenessClients.length > 0) {
      ws.send(encodeAwarenessUpdate(room.awareness, awarenessClients));
    }

    ws.on("message", (raw: Buffer) => {
      try {
        const data = new Uint8Array(raw);
        const decoder = decoding.createDecoder(data);
        const msgType = decoding.readVarUint(decoder);

        if (msgType === MESSAGE_SYNC) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          // readSyncMessage applies the incoming update to doc and writes any reply into encoder
          const syncReplyType = syncProtocol.readSyncMessage(decoder, encoder, room.doc, null);

          // If the lib wrote a reply (step2 in response to step1), send it back
          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }

          // For step2 / update messages, broadcast the raw frame to other room clients
          if (syncReplyType === syncProtocol.messageYjsSyncStep2 || syncReplyType === 2 /* update */) {
            broadcastToRoom(room, ws, data);
          }
        } else if (msgType === MESSAGE_AWARENESS) {
          const update = decoding.readVarUint8Array(decoder);
          awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
          // Pass awareness through to all other clients
          broadcastToRoom(room, ws, data);
        }
      } catch (err) {
        console.error("[sync] message error:", err);
      }
    });

    ws.on("close", () => {
      room.clients.delete(ws);
      room.awareness.off("update", onAwarenessUpdate);
      const ids = Array.from(controlledIds.get(ws) ?? []);
      if (ids.length > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, ids, null);
        broadcastToRoom(room, ws, encodeAwarenessUpdate(room.awareness, ids));
      }
      controlledIds.delete(ws);
      if (room.clients.size === 0) {
        console.log(`[sync] Room ${roomId} has no connected clients, persisting immediately.`);
        saveRoomPersistence(roomId, room.doc).catch((err) => {
          console.error(`[sync] Failed to persist room ${roomId} on last client leave:`, err);
        });
      }
      console.log(`[sync] Client ${clientInfo.userId} left room ${roomId}`);
    });
  }
);

// Graceful shutdown: save all dirty rooms before exit
const handleShutdown = async (signal: string) => {
  console.log(`[sync] Received ${signal}. Saving all dirty rooms to Postgres...`);
  for (const [roomId, room] of rooms.entries()) {
    await saveRoomPersistence(roomId, room.doc).catch(() => {});
  }
  process.exit(0);
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

server.listen(port, () => console.log(`Sync service running on :${port}`));

export { server, rooms, getRoom };

