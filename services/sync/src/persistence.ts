/**
 * Postgres persistence for room Y.Docs (Phase 2 + Week 4 Task 4).
 *
 * Several sync nodes may hold the same room. Saving rules:
 *   1. Take a short Redis lock: SET lock:room:{roomId}:save <nodeId> NX PX 15000.
 *   2. Merge before writing: read the stored state, apply it to the doc (origin
 *      "db-merge"), then write the merged state. Older data never overwrites newer.
 *   3. The write is also a compare-and-set on ProjectFile.updatedAt, so two writers
 *      can never silently clobber each other even if the lock is unavailable
 *      (e.g. Redis is down); a lost race re-reads, re-merges and retries.
 *   4. Writes are skipped when the doc holds nothing the stored state lacks.
 *
 * Only locally-originated updates mark a room dirty and reset the idle indexing
 * timer (index.ts enforces this), so index events are not duplicated per node.
 */
import * as Y from "yjs";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import { prisma } from "./lib/prisma";
import { NODE_ID, log, logErr } from "./node";
import { redisPub, redisReady } from "./relay";
import { docHasDataBeyond } from "./ydiff";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
// Separate connection for the indexing stream (keeps its offline queue, so index
// events raised during a short Redis outage are delivered after reconnect).
const redis = new Redis(redisUrl);
redis.on("error", () => {});

export const ORIGIN_DB_LOAD = "db-load";
export const ORIGIN_DB_MERGE = "db-merge";

const LOCK_TTL_MS = 15000;
const INDEX_IDLE_MS = 5000;
const PERIODIC_SAVE_MS = 10000;

export interface RoomMeta {
  roomId: string;
  fileId: string;
  path: string;
  language: string;
  isDirty: boolean;
  dirtyVersion: number;
  idleTimer: NodeJS.Timeout | null;
  fallback: boolean;
}

export const persistStats = {
  saves: 0,
  savesUnchanged: 0,
  lockBusy: 0,
  savesWithoutLock: 0,
  casRetries: 0,
  dbMergesWithNewData: 0,
  saveErrors: 0,
};

const roomMetas = new Map<string, RoomMeta>();

const lockKey = (roomId: string) => `lock:room:${roomId}:save`;

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

type LockResult = { kind: "held"; token: string } | { kind: "busy" } | { kind: "unavailable" };

async function acquireLock(roomId: string, attempts: number): Promise<LockResult> {
  const token = `${NODE_ID}:${randomUUID()}`;
  for (let i = 0; i < attempts; i++) {
    if (!redisReady()) return { kind: "unavailable" };
    try {
      const ok = await redisPub.set(lockKey(roomId), token, "PX", LOCK_TTL_MS, "NX");
      if (ok === "OK") return { kind: "held", token };
    } catch {
      return { kind: "unavailable" };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 100 + Math.random() * 100));
  }
  return { kind: "busy" };
}

async function releaseLock(roomId: string, token: string) {
  try {
    await redisPub.eval(RELEASE_LUA, 1, lockKey(roomId), token);
  } catch {
    /* lock expires on its own after LOCK_TTL_MS */
  }
}

/**
 * Load (or create) the room's ProjectFile and apply its stored state to `doc`.
 * Concurrent first loads of a brand-new room on two nodes may both try to create
 * the row; the loser of the unique (roomId, path) race re-reads it.
 */
export async function loadRoomPersistence(roomId: string, doc: Y.Doc): Promise<RoomMeta> {
  const existing = roomMetas.get(roomId);
  if (existing) return existing;

  try {
    let projectFile = await prisma.projectFile.findFirst({ where: { roomId }, orderBy: { path: "asc" } });

    if (projectFile) {
      if (projectFile.yjsState && projectFile.yjsState.length > 0) {
        log(`Loading existing Yjs state for room ${roomId} (${projectFile.yjsState.length} bytes)`);
        Y.applyUpdate(doc, new Uint8Array(projectFile.yjsState), ORIGIN_DB_LOAD);
      }
    } else {
      const room = await prisma.room.findUnique({ where: { id: roomId } });
      const defaultLang = room?.defaultLang || "typescript";
      const ext = defaultLang === "python" ? "py" : defaultLang === "typescript" ? "ts" : "js";
      const defaultPath = `main.${ext}`;
      log(`Creating initial ProjectFile for room ${roomId} (${defaultPath})`);
      try {
        projectFile = await prisma.projectFile.create({
          data: { roomId, path: defaultPath, language: defaultLang, yjsState: Buffer.from(Y.encodeStateAsUpdate(doc)) },
        });
      } catch (err: any) {
        if (err?.code !== "P2002") throw err;
        projectFile = await prisma.projectFile.findFirst({ where: { roomId }, orderBy: { path: "asc" } });
        if (!projectFile) throw err;
        if (projectFile.yjsState && projectFile.yjsState.length > 0) {
          Y.applyUpdate(doc, new Uint8Array(projectFile.yjsState), ORIGIN_DB_LOAD);
        }
      }
    }

    const meta: RoomMeta = {
      roomId,
      fileId: projectFile.id,
      path: projectFile.path,
      language: projectFile.language,
      isDirty: false,
      dirtyVersion: 0,
      idleTimer: null,
      fallback: false,
    };
    roomMetas.set(roomId, meta);
    return meta;
  } catch (err) {
    logErr(`Error loading room persistence for ${roomId}:`, err);
    // DB unavailable: serve the room in memory but never write (fallback has no row).
    const fallbackMeta: RoomMeta = {
      roomId,
      fileId: `fallback-${roomId}`,
      path: "main.ts",
      language: "typescript",
      isDirty: false,
      dirtyVersion: 0,
      idleTimer: null,
      fallback: true,
    };
    roomMetas.set(roomId, fallbackMeta);
    return fallbackMeta;
  }
}

export type SaveResult = "saved" | "unchanged" | "clean" | "lock-busy" | "no-meta" | "error";

/**
 * Save a room under the lock with merge-before-write.
 * - force=false (periodic): only when dirty; one lock attempt, retried next period.
 * - force=true (last client left / unload / shutdown): always runs the merge check,
 *   so a node that only received remote updates still persists what it holds (this
 *   is what keeps edits when the node that originated them was killed).
 */
export async function saveRoomPersistence(roomId: string, doc: Y.Doc, opts: { force?: boolean } = {}): Promise<SaveResult> {
  const meta = roomMetas.get(roomId);
  if (!meta || meta.fallback) return "no-meta";
  if (!opts.force && !meta.isDirty) return "clean";

  const versionAtStart = meta.dirtyVersion;
  const lock = await acquireLock(roomId, opts.force ? 30 : 1);
  if (lock.kind === "busy") {
    persistStats.lockBusy++;
    return "lock-busy";
  }
  if (lock.kind === "unavailable") persistStats.savesWithoutLock++;

  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await prisma.projectFile.findUnique({
        where: { id: meta.fileId },
        select: { yjsState: true, updatedAt: true },
      });
      if (!row) {
        logErr(`ProjectFile ${meta.fileId} for room ${roomId} vanished; not saving`);
        return "error";
      }
      const stored = row.yjsState && row.yjsState.length > 0 ? new Uint8Array(row.yjsState) : null;

      if (stored) {
        // Merge: anything another node stored that we lack enters our doc.
        const before = Y.encodeStateVector(doc);
        Y.applyUpdate(doc, stored, ORIGIN_DB_MERGE);
        const after = Y.encodeStateVector(doc);
        if (Buffer.compare(Buffer.from(before), Buffer.from(after)) !== 0) persistStats.dbMergesWithNewData++;

        if (!docHasDataBeyond(doc, stored)) {
          persistStats.savesUnchanged++;
          if (meta.dirtyVersion === versionAtStart) meta.isDirty = false;
          return "unchanged";
        }
      }

      const merged = Buffer.from(Y.encodeStateAsUpdate(doc));
      const res = await prisma.projectFile.updateMany({
        where: { id: meta.fileId, updatedAt: row.updatedAt },
        data: { yjsState: merged },
      });
      if (res.count === 1) {
        persistStats.saves++;
        if (meta.dirtyVersion === versionAtStart) meta.isDirty = false;
        log(`Persisted Yjs state for room ${roomId} (${merged.length} bytes, lock=${lock.kind})`);
        return "saved";
      }
      persistStats.casRetries++; // someone wrote in between: re-read, re-merge, retry
    }
    persistStats.saveErrors++;
    logErr(`Gave up saving room ${roomId} after repeated concurrent writes`);
    return "error";
  } catch (err) {
    persistStats.saveErrors++;
    logErr(`Failed to persist Yjs state for room ${roomId}:`, err);
    return "error";
  } finally {
    if (lock.kind === "held") await releaseLock(roomId, lock.token);
  }
}

async function publishIndexEvent(meta: RoomMeta, doc: Y.Doc) {
  try {
    const content = doc.getText("content").toString();
    await redis.xadd(
      "stream:ai_indexing", "*",
      "roomId", meta.roomId,
      "fileId", meta.fileId,
      "path", meta.path,
      "language", meta.language,
      "content", content,
      "eventType", "update"
    );
    log(`Published idle index event to stream:ai_indexing for room ${meta.roomId} (file ${meta.path})`);
  } catch (err) {
    logErr(`Failed to publish stream:ai_indexing event for room ${meta.roomId}:`, err);
  }
}

/**
 * A LOCALLY-originated edit arrived: mark dirty and (re)start the 5s idle timer that
 * publishes a stream:ai_indexing event. Never call this for "redis"/"redis-sync"/
 * "db-*" origins.
 */
export function markRoomDirty(roomId: string, doc: Y.Doc): void {
  const meta = roomMetas.get(roomId);
  if (!meta) return;
  meta.isDirty = true;
  meta.dirtyVersion++;
  if (meta.idleTimer) clearTimeout(meta.idleTimer);
  meta.idleTimer = setTimeout(() => {
    meta.idleTimer = null;
    void publishIndexEvent(meta, doc);
  }, INDEX_IDLE_MS);
}

/** Drop cached metadata when a room is unloaded; flush a pending index event. */
export function forgetRoomMeta(roomId: string, doc: Y.Doc): void {
  const meta = roomMetas.get(roomId);
  if (!meta) return;
  if (meta.idleTimer) {
    clearTimeout(meta.idleTimer);
    meta.idleTimer = null;
    void publishIndexEvent(meta, doc);
  }
  roomMetas.delete(roomId);
}

export function getRoomMeta(roomId: string): RoomMeta | undefined {
  return roomMetas.get(roomId);
}

export async function publishFileDeletedEvent(roomId: string, fileId: string, path: string): Promise<void> {
  try {
    await redis.xadd("stream:ai_indexing", "*", "roomId", roomId, "fileId", fileId, "path", path, "eventType", "delete");
    log(`Published file deleted event to stream:ai_indexing (fileId ${fileId})`);
  } catch (err) {
    logErr(`Failed to publish delete event for file ${fileId}:`, err);
  }
}

/** Every 10s, save dirty rooms (single lock attempt; busy rooms retry next period). */
export function startPeriodicPersistence(rooms: Map<string, { doc: Y.Doc }>): NodeJS.Timeout {
  const t = setInterval(async () => {
    for (const [roomId, room] of rooms.entries()) {
      const meta = roomMetas.get(roomId);
      if (meta && meta.isDirty) await saveRoomPersistence(roomId, room.doc);
    }
  }, PERIODIC_SAVE_MS);
  t.unref();
  return t;
}

export { redis };
