/**
 * Cross-node relay over Redis Pub/Sub (Week 4 Tasks 2, 3, 5; Phase 6 A3).
 *
 * Two Redis connections per node: `pub` (publish only) and `sub` (subscribe only).
 *
 * Wire format (binary, read with the messageBuffer event so bytes survive):
 *   varString(nodeId)            -- lib0 varString = varUint length prefix + UTF-8
 *   ...payload
 *
 * Channels per room:
 *   room:{roomId}:updates    payload = raw Yjs update
 *   room:{roomId}:awareness  payload = raw awareness update
 *   room:{roomId}:sync       payload = varUint(kind) + body
 *       kind 0 SYNC_REQUEST  body = varUint8Array(stateVector) + varUint8Array(deleteSet)
 *       kind 1 SYNC_REPLY    body = varString(targetNodeId) + varUint8Array(diff)
 *
 * Rules:
 *   - Messages whose nodeId is our own are ignored (counted as ignoredSelfEchoes).
 *   - Updates from Redis are applied with origin "redis"; sync replies with origin
 *     "redis-sync". index.ts broadcasts both to local websocket clients and never
 *     re-publishes them.
 *   - A sync reply is skipped when it carries no data the requester lacks: no new
 *     structs AND every deletion is already in the requester's delete set. (An empty
 *     Yjs update is 2 bytes, but a diff always carries the sender's full delete set,
 *     so after any deletion a "nothing new" diff is larger than 2 bytes. Checking the
 *     length alone would therefore never skip.)
 */
import Redis from "ioredis";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { NODE_ID, log, logErr } from "./node";
import { diffHasNewData } from "./ydiff";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6380";
export const COLD_SYNC_WAIT_MS = Number(process.env.COLD_SYNC_WAIT_MS ?? 300);
export const ANTI_ENTROPY_INTERVAL_MS = Number(process.env.ANTI_ENTROPY_INTERVAL_MS ?? 15000);

const SYNC_REQUEST = 0;
const SYNC_REPLY = 1;

export const ORIGIN_REDIS = "redis";
export const ORIGIN_REDIS_SYNC = "redis-sync";

export const stats = {
  publishedUpdates: 0,
  publishedAwareness: 0,
  publishFailures: 0,
  receivedUpdates: 0,
  receivedAwareness: 0,
  ignoredSelfEchoes: 0,
  syncRequestsSent: 0,
  syncRequestsReceived: 0,
  syncRepliesSent: 0,
  syncRepliesSkippedNoNewData: 0,
  syncRepliesApplied: 0,
  antiEntropyRounds: 0,
  redisReconnects: 0,
};

/** What the relay needs from the room registry in index.ts. */
export interface RelayRoom {
  doc: Y.Doc;
  applyRemoteAwareness: (update: Uint8Array) => void;
}

type RoomLookup = (roomId: string) => RelayRoom | undefined;

const chan = {
  updates: (r: string) => `room:${r}:updates`,
  awareness: (r: string) => `room:${r}:awareness`,
  sync: (r: string) => `room:${r}:sync`,
};
const CHANNEL_RE = /^room:(.+):(updates|awareness|sync)$/;

// Publisher fails fast while Redis is down (no offline queue), so an outage is
// visible in publishFailures and repaired by anti-entropy rather than by a silent,
// unbounded in-memory queue.
const pub = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: false });
const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

pub.on("error", (e) => logErr("redis pub error:", e.message));
sub.on("error", (e) => logErr("redis sub error:", e.message));

let lookupRoom: RoomLookup = () => undefined;
let activeRoomIds: () => string[] = () => [];
const subscribed = new Set<string>();
/** Waiters for the first SYNC_REPLY addressed to us, per room. */
const replyWaiters = new Map<string, Array<() => void>>();

let everReady = false;

export const redisReady = () => pub.status === "ready";

const frame = (writeBody: (e: encoding.Encoder) => void): Buffer => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, NODE_ID);
  writeBody(e);
  return Buffer.from(encoding.toUint8Array(e));
};

const safePublish = async (channel: string, data: Buffer): Promise<boolean> => {
  try {
    await pub.publish(channel, data);
    return true;
  } catch (err) {
    stats.publishFailures++;
    return false;
  }
};

export function initRelay(lookup: RoomLookup, activeRooms: () => string[]) {
  lookupRoom = lookup;
  activeRoomIds = activeRooms;

  sub.on("messageBuffer", (channelBuf: Buffer, message: Buffer) => {
    try {
      handleMessage(channelBuf.toString(), message);
    } catch (err) {
      logErr("relay message error:", (err as Error).message);
    }
  });

  // ioredis re-subscribes automatically on reconnect. When it does, re-announce
  // state vectors so anything missed during the outage is repaired (A3).
  sub.on("ready", () => {
    if (everReady) {
      stats.redisReconnects++;
      log("redis subscriber reconnected; running anti-entropy round");
      void antiEntropyRound();
    }
    everReady = true;
  });

  setInterval(() => void antiEntropyRound(), ANTI_ENTROPY_INTERVAL_MS).unref();
}

function handleMessage(channel: string, message: Buffer) {
  const m = CHANNEL_RE.exec(channel);
  if (!m) return;
  const [, roomId, kind] = m;
  const dec = decoding.createDecoder(new Uint8Array(message));
  const sender = decoding.readVarString(dec);
  if (sender === NODE_ID) {
    stats.ignoredSelfEchoes++;
    return;
  }
  const room = lookupRoom(roomId);
  if (!room) return;

  if (kind === "updates") {
    const update = decoding.readTailAsUint8Array(dec);
    stats.receivedUpdates++;
    Y.applyUpdate(room.doc, update, ORIGIN_REDIS);
  } else if (kind === "awareness") {
    const update = decoding.readTailAsUint8Array(dec);
    stats.receivedAwareness++;
    room.applyRemoteAwareness(update);
  } else {
    const msgKind = decoding.readVarUint(dec);
    if (msgKind === SYNC_REQUEST) {
      stats.syncRequestsReceived++;
      const theirSv = decoding.readVarUint8Array(dec);
      const theirDs = decoding.hasContent(dec) ? decoding.readVarUint8Array(dec) : null;
      void answerSyncRequest(roomId, room.doc, sender, theirSv, theirDs);
    } else if (msgKind === SYNC_REPLY) {
      const target = decoding.readVarString(dec);
      if (target !== NODE_ID) return;
      const diff = decoding.readVarUint8Array(dec);
      stats.syncRepliesApplied++;
      Y.applyUpdate(room.doc, diff, ORIGIN_REDIS_SYNC);
      const waiters = replyWaiters.get(roomId);
      if (waiters) {
        replyWaiters.delete(roomId);
        waiters.forEach((w) => w());
      }
    }
  }
}

/**
 * Encode the doc's delete set so a responder can tell whether its deletions are new.
 * A Yjs snapshot is exactly (deleteSet, stateVector), so its encoding carries it.
 */
const encodeDeleteSet = (doc: Y.Doc): Uint8Array => Y.encodeSnapshot(Y.snapshot(doc));

async function answerSyncRequest(
  roomId: string,
  doc: Y.Doc,
  requester: string,
  theirSv: Uint8Array,
  theirDsSnapshot: Uint8Array | null
) {
  const diff = Y.encodeStateAsUpdate(doc, theirSv);
  const theirSnapshot = theirDsSnapshot ? Y.decodeSnapshot(theirDsSnapshot) : null;
  if (!diffHasNewData(doc, diff, theirSnapshot)) {
    stats.syncRepliesSkippedNoNewData++;
    return;
  }
  const ok = await safePublish(
    chan.sync(roomId),
    frame((e) => {
      encoding.writeVarUint(e, SYNC_REPLY);
      encoding.writeVarString(e, requester);
      encoding.writeVarUint8Array(e, diff);
    })
  );
  if (ok) stats.syncRepliesSent++;
}

/** Publish our state vector + delete set for a room; peers answer with a diff. */
async function publishSyncRequest(roomId: string, doc: Y.Doc): Promise<boolean> {
  const ok = await safePublish(
    chan.sync(roomId),
    frame((e) => {
      encoding.writeVarUint(e, SYNC_REQUEST);
      encoding.writeVarUint8Array(e, Y.encodeStateVector(doc));
      encoding.writeVarUint8Array(e, encodeDeleteSet(doc));
    })
  );
  if (ok) stats.syncRequestsSent++;
  return ok;
}

async function antiEntropyRound() {
  if (!redisReady()) return;
  stats.antiEntropyRounds++;
  for (const roomId of activeRoomIds()) {
    const room = lookupRoom(roomId);
    if (room) await publishSyncRequest(roomId, room.doc);
  }
}

/** Subscribe to a room's three channels. Resolves once Redis confirms (or fails). */
export async function subscribeRoom(roomId: string): Promise<void> {
  if (subscribed.has(roomId)) return;
  subscribed.add(roomId);
  try {
    await sub.subscribe(chan.updates(roomId), chan.awareness(roomId), chan.sync(roomId));
  } catch (err) {
    // Redis down: ioredis keeps the subscription intent and re-subscribes on reconnect.
    logErr(`subscribe ${roomId} failed (will resubscribe on reconnect):`, (err as Error).message);
  }
}

export async function unsubscribeRoom(roomId: string): Promise<void> {
  if (!subscribed.delete(roomId)) return;
  try {
    await sub.unsubscribe(chan.updates(roomId), chan.awareness(roomId), chan.sync(roomId));
  } catch {
    /* ignore */
  }
}

/**
 * Cold-start (Task 3): after loading from Postgres, ask peers for anything newer and
 * wait up to COLD_SYNC_WAIT_MS for the first reply. Returns whether a reply arrived.
 */
export async function coldStartSync(roomId: string, doc: Y.Doc): Promise<boolean> {
  if (!redisReady()) return false;
  let resolveFn!: (v: boolean) => void;
  const got = new Promise<boolean>((r) => (resolveFn = r));
  const list = replyWaiters.get(roomId) ?? [];
  list.push(() => resolveFn(true));
  replyWaiters.set(roomId, list);
  const timer = setTimeout(() => resolveFn(false), COLD_SYNC_WAIT_MS);
  const sent = await publishSyncRequest(roomId, doc);
  if (!sent) resolveFn(false);
  const result = await got;
  clearTimeout(timer);
  replyWaiters.delete(roomId);
  return result;
}

export async function publishUpdate(roomId: string, update: Uint8Array) {
  const ok = await safePublish(chan.updates(roomId), frame((e) => encoding.writeUint8Array(e, update)));
  if (ok) stats.publishedUpdates++;
}

export async function publishAwareness(roomId: string, update: Uint8Array) {
  const ok = await safePublish(chan.awareness(roomId), frame((e) => encoding.writeUint8Array(e, update)));
  if (ok) stats.publishedAwareness++;
}

export { pub as redisPub };
