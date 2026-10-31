import * as Y from "yjs";
import Redis from "ioredis";
import { prisma } from "./lib/prisma";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redis = new Redis(redisUrl);

export interface RoomMeta {
  roomId: string;
  fileId: string;
  path: string;
  language: string;
  isDirty: boolean;
  idleTimer: NodeJS.Timeout | null;
}

const roomMetas = new Map<string, RoomMeta>();

/**
 * Load or initialize room state from PostgreSQL.
 * If a ProjectFile exists with yjsState, it is applied to the Y.Doc.
 * Otherwise, a default ProjectFile is created.
 */
export async function loadRoomPersistence(roomId: string, doc: Y.Doc): Promise<RoomMeta> {
  let existingMeta = roomMetas.get(roomId);
  if (existingMeta) {
    return existingMeta;
  }

  try {
    // 1. Look for existing ProjectFile
    let projectFile = await prisma.projectFile.findFirst({
      where: { roomId },
      orderBy: { createdAt: "asc" } as any,
    }).catch(async () => {
      // In case createdAt is not present, find by roomId only
      return await prisma.projectFile.findFirst({ where: { roomId } });
    });

    if (projectFile) {
      if (projectFile.yjsState && projectFile.yjsState.length > 0) {
        console.log(`[sync] Loading existing Yjs state for room ${roomId} (${projectFile.yjsState.length} bytes)`);
        Y.applyUpdate(doc, new Uint8Array(projectFile.yjsState));
      }
    } else {
      // Look up room to get default language
      const room = await prisma.room.findUnique({ where: { id: roomId } });
      const defaultLang = room?.defaultLang || "typescript";
      const ext = defaultLang === "python" ? "py" : defaultLang === "typescript" ? "ts" : "js";
      const defaultPath = `main.${ext}`;

      console.log(`[sync] Creating initial ProjectFile for room ${roomId} (${defaultPath})`);
      const initialState = Buffer.from(Y.encodeStateAsUpdate(doc));
      projectFile = await prisma.projectFile.create({
        data: {
          roomId,
          path: defaultPath,
          language: defaultLang,
          yjsState: initialState,
        },
      });
    }

    const meta: RoomMeta = {
      roomId,
      fileId: projectFile.id,
      path: projectFile.path,
      language: projectFile.language,
      isDirty: false,
      idleTimer: null,
    };

    roomMetas.set(roomId, meta);
    return meta;
  } catch (err) {
    console.error(`[sync] Error loading room persistence for ${roomId}:`, err);
    // Fallback meta in case DB query fails temporarily
    const fallbackMeta: RoomMeta = {
      roomId,
      fileId: `fallback-${roomId}`,
      path: "main.ts",
      language: "typescript",
      isDirty: false,
      idleTimer: null,
    };
    roomMetas.set(roomId, fallbackMeta);
    return fallbackMeta;
  }
}

/**
 * Save Yjs document state to PostgreSQL ProjectFile.yjsState.
 */
export async function saveRoomPersistence(roomId: string, doc: Y.Doc): Promise<void> {
  const meta = roomMetas.get(roomId);
  if (!meta || !meta.isDirty) return;

  try {
    const update = Y.encodeStateAsUpdate(doc);
    await prisma.projectFile.update({
      where: { id: meta.fileId },
      data: { yjsState: Buffer.from(update) },
    });
    meta.isDirty = false;
    console.log(`[sync] Persisted Yjs state to Postgres for room ${roomId} (${update.length} bytes)`);
  } catch (err) {
    console.error(`[sync] Failed to persist Yjs state for room ${roomId}:`, err);
  }
}

/**
 * Notify the persistence manager that a room has received an edit.
 * - Marks the room as dirty.
 * - Debounces a 5-second idle timer to publish a stream:ai_indexing event.
 */
export function markRoomDirty(roomId: string, doc: Y.Doc): void {
  const meta = roomMetas.get(roomId);
  if (!meta) return;

  meta.isDirty = true;

  // Debounce 5s idle indexing event
  if (meta.idleTimer) {
    clearTimeout(meta.idleTimer);
  }

  meta.idleTimer = setTimeout(async () => {
    meta.idleTimer = null;
    try {
      const content = doc.getText("content").toString();
      await redis.xadd(
        "stream:ai_indexing",
        "*",
        "roomId", meta.roomId,
        "fileId", meta.fileId,
        "path", meta.path,
        "language", meta.language,
        "content", content,
        "eventType", "update"
      );
      console.log(`[sync] Published idle index event to stream:ai_indexing for room ${roomId} (file ${meta.path})`);
    } catch (err) {
      console.error(`[sync] Failed to publish stream:ai_indexing event for room ${roomId}:`, err);
    }
  }, 5000);
}

/**
 * Publish a file deletion event to stream:ai_indexing.
 */
export async function publishFileDeletedEvent(roomId: string, fileId: string, path: string): Promise<void> {
  try {
    await redis.xadd(
      "stream:ai_indexing",
      "*",
      "roomId", roomId,
      "fileId", fileId,
      "path", path,
      "eventType", "delete"
    );
    console.log(`[sync] Published file deleted event to stream:ai_indexing (fileId ${fileId})`);
  } catch (err) {
    console.error(`[sync] Failed to publish delete event for file ${fileId}:`, err);
  }
}

/**
 * Background loop to persist dirty rooms every 10 seconds.
 */
export function startPeriodicPersistence(rooms: Map<string, { doc: Y.Doc }>): NodeJS.Timeout {
  return setInterval(async () => {
    for (const [roomId, room] of rooms.entries()) {
      const meta = roomMetas.get(roomId);
      if (meta && meta.isDirty) {
        await saveRoomPersistence(roomId, room.doc);
      }
    }
  }, 10000);
}

export { redis };
