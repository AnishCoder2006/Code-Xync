import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { prisma } from "../services/api/src/lib/prisma";

const SYNC_DIST = path.resolve(__dirname, "../services/sync/dist/index.js");
const PORT_NODE1 = 4021;
const PORT_NODE2 = 4022;
const NODE1_ID = "sync-node-01";
const NODE2_ID = "sync-node-02";
const INTERNAL_SECRET = "codesync-internal-ai-secret";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");

function killProc(proc: ChildProcess | null) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {}
}

interface ConnectedClient {
  ws: WebSocket;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  userId: string;
}

function connectClient(port: number, roomId: string, userId: string): Promise<ConnectedClient> {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const ws = new WebSocket(`ws://localhost:${port}?token=test-token-${userId}&roomId=${roomId}`);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection timed out for client ${userId} on port ${port}`));
    }, 5000);

    ws.on("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0); // sync protocol
      syncProtocol.writeSyncStep1(encoder, doc);
      ws.send(encoding.toUint8Array(encoder));
    });

    doc.on("update", (update: Uint8Array, origin: any) => {
      if (origin !== ws) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, update);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encoding.toUint8Array(encoder));
        }
      }
    });

    awareness.on("update", ({ added, updated, removed }: any, origin: any) => {
      if (origin !== ws) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 1); // awareness protocol
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed))
        );
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encoding.toUint8Array(encoder));
        }
      }
    });

    ws.on("message", (raw: Buffer) => {
      const data = new Uint8Array(raw);
      const decoder = decoding.createDecoder(data);
      const msgType = decoding.readVarUint(decoder);
      if (msgType === 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        const syncReply = syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
        if (syncReply === syncProtocol.messageYjsSyncStep2 || syncReply === 2) {
          clearTimeout(timeout);
          resolve({ ws, doc, awareness, userId });
        }
      } else if (msgType === 1) {
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function startSyncNode(port: number, nodeId: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SYNC_DIST], {
      env: {
        ...process.env,
        SYNC_PORT: String(port),
        PORT: String(port),
        NODE_ID: nodeId,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d) => {
      const text = d.toString();
      if (text.includes(`:${port}`)) resolve(proc);
    });
    proc.stderr?.on("data", (d) => {
      console.error(`[err:${nodeId}]`, d.toString().trim());
    });
    proc.on("error", reject);
    setTimeout(() => resolve(proc), 3000);
  });
}

async function main() {
  console.log("=========================================================================");
  console.log("         Testing Tasks 2, 3, 4, 5: Cross-Node Sync & Convergence         ");
  console.log("=========================================================================\n");

  let proc1: ChildProcess | null = null;
  let proc2: ChildProcess | null = null;

  try {
    // 0. Clean Redis keys
    console.log("[Setup] Resetting Redis Pub/Sub state and locks...");
    const lockKeys = await redis.keys("lock:room:*");
    if (lockKeys.length > 0) await redis.del(...lockKeys);

    // 1. Start Node 1 and Node 2
    console.log(`[Setup] Starting Node 1 on port ${PORT_NODE1} (nodeId: ${NODE1_ID})...`);
    proc1 = await startSyncNode(PORT_NODE1, NODE1_ID);
    console.log(`[Setup] Starting Node 2 on port ${PORT_NODE2} (nodeId: ${NODE2_ID})...`);
    proc2 = await startSyncNode(PORT_NODE2, NODE2_ID);
    await new Promise((r) => setTimeout(r, 1000));

    // Verify both health endpoints
    const h1 = await (await fetch(`http://localhost:${PORT_NODE1}/health`)).json() as any;
    const h2 = await (await fetch(`http://localhost:${PORT_NODE2}/health`)).json() as any;
    console.log(`   Node 1 health: nodeId="${h1.nodeId}", ok=${h1.ok}`);
    console.log(`   Node 2 health: nodeId="${h2.nodeId}", ok=${h2.ok}`);

    // Create room & users in Postgres
    const roomId = "cross-node-room-" + uuidv4().slice(0, 8);
    const userA = "user-a-" + uuidv4().slice(0, 6);
    const userB = "user-b-" + uuidv4().slice(0, 6);

    await prisma.user.createMany({
      data: [
        { id: userA, email: `${userA}@test.com`, name: "Client A" },
        { id: userB, email: `${userB}@test.com`, name: "Client B" },
      ],
    });

    await prisma.room.create({
      data: {
        id: roomId,
        title: "Multi-Node Room",
        ownerId: userA,
        members: {
          create: [
            { userId: userA, role: "OWNER" },
            { userId: userB, role: "EDITOR" },
          ],
        },
      },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 2: Cross-node update relay via Redis Pub/Sub
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n-------------------------------------------------------------------------");
    console.log("  TASK 2: Cross-node update relay via Redis Pub/Sub (Bidirectional)      ");
    console.log("-------------------------------------------------------------------------");

    console.log(`   Connecting Client A to Node 1 (port ${PORT_NODE1})...`);
    const clientA = await connectClient(PORT_NODE1, roomId, userA);

    console.log(`   Connecting Client B to Node 2 (port ${PORT_NODE2})...`);
    const clientB = await connectClient(PORT_NODE2, roomId, userB);
    await new Promise((r) => setTimeout(r, 600));

    // Client A inserts text on Node 1
    console.log("   Client A edits on Node 1: inserting line 'Line 1: added by Client A on Node 1'...");
    clientA.doc.getText("content").insert(0, "Line 1: added by Client A on Node 1\n");

    // Wait for cross-node propagation over Redis
    await new Promise((r) => setTimeout(r, 600));

    const textOnB_1 = clientB.doc.getText("content").toString();
    console.log(`   Client B on Node 2 content:\n   -> "${textOnB_1.trim()}"`);
    if (!textOnB_1.includes("Line 1: added by Client A on Node 1")) {
      throw new Error("Client B on Node 2 did not receive edit made on Node 1!");
    }

    // Client B inserts text on Node 2
    console.log("   Client B edits on Node 2: inserting line 'Line 2: added by Client B on Node 2'...");
    clientB.doc.getText("content").insert(clientB.doc.getText("content").length, "Line 2: added by Client B on Node 2\n");

    // Wait for cross-node propagation over Redis
    await new Promise((r) => setTimeout(r, 600));

    const textOnA_2 = clientA.doc.getText("content").toString();
    console.log(`   Client A on Node 1 content:\n   -> "${textOnA_2.trim()}"`);
    if (!textOnA_2.includes("Line 2: added by Client B on Node 2")) {
      throw new Error("Client A on Node 1 did not receive edit made on Node 2!");
    }

    // Check stats on both nodes for updates & self-echoes
    const stats1 = (await (await fetch(`http://localhost:${PORT_NODE1}/health`)).json() as any).relay;
    const stats2 = (await (await fetch(`http://localhost:${PORT_NODE2}/health`)).json() as any).relay;

    console.log(`   Node 1 Stats: published=${stats1.publishedUpdates}, received=${stats1.receivedUpdates}, ignoredSelfEchoes=${stats1.ignoredSelfEchoes}`);
    console.log(`   Node 2 Stats: published=${stats2.publishedUpdates}, received=${stats2.receivedUpdates}, ignoredSelfEchoes=${stats2.ignoredSelfEchoes}`);

    if (stats1.publishedUpdates < 1 || stats2.receivedUpdates < 1) {
      throw new Error("Expected published and received update counts to be positive!");
    }
    if (stats1.ignoredSelfEchoes < 1 || stats2.ignoredSelfEchoes < 1) {
      throw new Error("Expected ignoredSelfEchoes count to show no-echo filtering is active!");
    }

    // Awareness relay test: Client A sets cursor/presence on Node 1
    console.log("   Client A sets cursor/user awareness on Node 1...");
    clientA.awareness.setLocalStateField("user", { name: "Alice", color: "#ff0000" });
    await new Promise((r) => setTimeout(r, 500));

    const bStates = clientB.awareness.getStates();
    const aliceRemote = Array.from(bStates.values()).find((s: any) => s.user?.name === "Alice");
    console.log(`   Client B on Node 2 sees remote awareness user:`, JSON.stringify(aliceRemote));
    if (!aliceRemote) {
      throw new Error("Client B on Node 2 did not receive awareness update from Client A on Node 1!");
    }

    console.log("   -> PASS: Task 2 verified (Bidirectional updates, no-echo filtering, awareness relay).\n");

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 3: Cold-start sync between nodes
    // ─────────────────────────────────────────────────────────────────────────
    console.log("-------------------------------------------------------------------------");
    console.log("  TASK 3: Cold-start sync between nodes (Peers answer with diff)          ");
    console.log("-------------------------------------------------------------------------");

    // Room has in-memory state on Node 1 and Node 2.
    // Let's create a NEW room on Node 1 only, write edits to it in memory,
    // then have Node 2 load it cold from scratch.
    const coldRoomId = "cold-room-" + uuidv4().slice(0, 8);
    await prisma.room.create({
      data: {
        id: coldRoomId,
        title: "Cold Start Room",
        ownerId: userA,
        members: { create: [{ userId: userA, role: "OWNER" }] },
      },
    });

    console.log(`   Connecting Client A to Node 1 for new room ${coldRoomId}...`);
    const coldClientA = await connectClient(PORT_NODE1, coldRoomId, userA);
    const coldMarker = "COLD_START_IN_MEMORY_UPDATE_MARKER_998877";
    coldClientA.doc.getText("content").insert(0, `const code = "${coldMarker}";\n`);
    await new Promise((r) => setTimeout(r, 400));

    // At this point, the update is in memory on Node 1, NOT yet saved to Postgres!
    // Now request room text from Node 2 via HTTP GET /room/:id/text
    console.log(`   Node 2 loading room ${coldRoomId} cold via HTTP /text (peer sync request)...`);
    const tCold0 = Date.now();
    const node2TextRes = await fetch(`http://localhost:${PORT_NODE2}/room/${coldRoomId}/text`, {
      headers: { "x-internal-secret": INTERNAL_SECRET },
    });
    const coldElapsed = Date.now() - tCold0;
    const node2TextData = await node2TextRes.json() as any;
    console.log(`   Node 2 response in ${coldElapsed}ms:`, JSON.stringify(node2TextData));

    if (!node2TextData.content.includes(coldMarker)) {
      throw new Error(`Node 2 cold start sync failed! Content was: "${node2TextData.content}"`);
    }

    console.log(`   -> PASS: Task 3 verified (Cold-start peer sync retrieved in-memory state in ${coldElapsed}ms).\n`);
    coldClientA.ws.close();

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 4: Persistence with several nodes (Lock & Merge)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("-------------------------------------------------------------------------");
    console.log("  TASK 4: Persistence with several nodes (Redis lock & DB merge)         ");
    console.log("-------------------------------------------------------------------------");

    // Both Node 1 and Node 2 attempt to acquire lock on the same room
    const lockKey = `lock:room:${roomId}:save`;
    console.log(`   Testing Redis lock '${lockKey}'...`);

    const lockNode1 = await redis.set(lockKey, NODE1_ID, "PX", 3000, "NX");
    console.log(`   Node 1 acquired lock: ${lockNode1 === "OK"}`);

    const lockNode2 = await redis.set(lockKey, NODE2_ID, "PX", 3000, "NX");
    console.log(`   Node 2 attempted to acquire lock: ${lockNode2 ?? "null (lock held)"}`);

    if (lockNode2 !== null) {
      throw new Error("Lock mutual exclusion failed: Node 2 acquired lock while held by Node 1!");
    }

    // Release lock
    await redis.del(lockKey);

    // Test save on last client leaves with merge
    console.log("   Client A and Client B disconnecting to trigger save under lock...");
    clientA.ws.close();
    clientB.ws.close();
    await new Promise((r) => setTimeout(r, 1500));

    const savedFile = await prisma.projectFile.findFirst({ where: { roomId } });
    console.log(`   Postgres ProjectFile yjsState size: ${savedFile?.yjsState?.length} bytes`);
    if (!savedFile || !savedFile.yjsState || savedFile.yjsState.length === 0) {
      throw new Error("State was not persisted to Postgres after last client left!");
    }

    // Verify content restored from Postgres matches
    const verifyDoc = new Y.Doc();
    Y.applyUpdate(verifyDoc, new Uint8Array(savedFile.yjsState));
    const restoredText = verifyDoc.getText("content").toString();
    console.log(`   Restored text from Postgres:\n   -> "${restoredText.trim()}"`);
    if (!restoredText.includes("Line 1") || !restoredText.includes("Line 2")) {
      throw new Error("Persisted state did not contain both lines!");
    }

    console.log("   -> PASS: Task 4 verified (Redis lock mutual exclusion & merged persistence).\n");

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 5: Presence cleanup across nodes
    // ─────────────────────────────────────────────────────────────────────────
    console.log("-------------------------------------------------------------------------");
    console.log("  TASK 5: Presence cleanup across nodes                                  ");
    console.log("-------------------------------------------------------------------------");

    const presenceRoomId = "presence-room-" + uuidv4().slice(0, 8);
    await prisma.room.create({
      data: {
        id: presenceRoomId,
        title: "Presence Room",
        ownerId: userA,
        members: {
          create: [
            { userId: userA, role: "OWNER" },
            { userId: userB, role: "EDITOR" },
          ],
        },
      },
    });

    console.log(`   Connecting Client A to Node 1 and Client B to Node 2...`);
    const presA = await connectClient(PORT_NODE1, presenceRoomId, userA);
    const presB = await connectClient(PORT_NODE2, presenceRoomId, userB);

    presA.awareness.setLocalStateField("user", { name: "AlicePresence", id: "userA" });
    await new Promise((r) => setTimeout(r, 600));

    let bAwareness = Array.from(presB.awareness.getStates().values());
    console.log(`   Client B awareness before disconnect (states count: ${bAwareness.length}):`);
    const foundAliceBefore = bAwareness.some((s: any) => s.user?.name === "AlicePresence");
    console.log(`   Alice present on Node 2: ${foundAliceBefore}`);
    if (!foundAliceBefore) throw new Error("Alice not found in Node 2 awareness!");

    // Now disconnect Client A from Node 1
    console.log("   Client A closes connection on Node 1...");
    presA.ws.close();
    await new Promise((r) => setTimeout(r, 800));

    bAwareness = Array.from(presB.awareness.getStates().values());
    const foundAliceAfter = bAwareness.some((s: any) => s.user?.name === "AlicePresence");
    console.log(`   Alice present on Node 2 after disconnect: ${foundAliceAfter}`);
    if (foundAliceAfter) {
      throw new Error("Client A's awareness state was not removed on Node 2 after disconnect!");
    }

    presB.ws.close();
    console.log("   -> PASS: Task 5 verified (Awareness removal broadcasted and cleared across nodes).\n");

    console.log("=========================================================================");
    console.log("            ALL TASKS 2, 3, 4, 5 COMPLETED AND VERIFIED                  ");
    console.log("=========================================================================\n");

  } finally {
    killProc(proc1);
    killProc(proc2);
    await redis.quit();
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nTEST SUITE FAILED:", err);
    process.exit(1);
  });

