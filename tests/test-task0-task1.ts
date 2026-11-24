import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../services/api/src/lib/prisma";

const SYNC_DIST = path.resolve(__dirname, "../services/sync/dist/index.js");
const PORT = 4010;
const NODE_ID = "sync-node-identity-01";

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

function connectClient(port: number, roomId: string, userId: string): Promise<{ ws: WebSocket; text: string }> {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const ws = new WebSocket(`ws://localhost:${port}?token=test-token-${userId}&roomId=${roomId}`);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection timed out for client ${userId}`));
    }, 5000);

    ws.on("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0); // sync protocol
      syncProtocol.writeSyncStep1(encoder, doc);
      ws.send(encoding.toUint8Array(encoder));
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
          // Allow small settle for ytext update
          setTimeout(() => {
            const text = doc.getText("content").toString();
            resolve({ ws, text });
          }, 100);
        }
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function main() {
  console.log("=========================================================================");
  console.log("             Testing Task 0 (Room-Loading Race) & Task 1 (Node Identity) ");
  console.log("=========================================================================\n");

  let syncProc: ChildProcess | null = null;

  try {
    // 1. Prepare seeded room with real persisted content in Postgres
    const ownerId = "owner-" + uuidv4().slice(0, 8);
    const roomId = "persisted-room-" + uuidv4().slice(0, 8);

    await prisma.user.create({
      data: { id: ownerId, email: `${ownerId}@test.com`, name: "Owner" },
    });

    await prisma.room.create({
      data: {
        id: roomId,
        title: "Persisted Race Test Room",
        ownerId,
        members: { create: [{ userId: ownerId, role: "OWNER" }] },
      },
    });

    // Create a Y.Doc with distinct persisted content
    const sampleText =
`// PERSISTED DOCUMENT CONTENT
function calculateTax(subtotal: number, taxRate: number): number {
  if (subtotal < 0 || taxRate < 0) {
    throw new Error("Invalid parameters");
  }
  return subtotal * taxRate;
}

export { calculateTax };
`;
    const seedDoc = new Y.Doc();
    seedDoc.getText("content").insert(0, sampleText);
    const yjsUpdate = Buffer.from(Y.encodeStateAsUpdate(seedDoc));

    await prisma.projectFile.create({
      data: {
        roomId,
        path: "main.ts",
        language: "typescript",
        yjsState: yjsUpdate,
      },
    });

    console.log(`[Setup] Created room ${roomId} with ${yjsUpdate.length} bytes of persisted Yjs state in Postgres.`);

    // 2. Start sync service node with NODE_ID on PORT
    console.log(`[Setup] Starting sync node on port ${PORT} with NODE_ID='${NODE_ID}'...`);
    let logOutput = "";

    await new Promise<void>((resolve, reject) => {
      syncProc = spawn("node", [SYNC_DIST], {
        env: {
          ...process.env,
          SYNC_PORT: String(PORT),
          PORT: String(PORT),
          NODE_ID: NODE_ID,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      syncProc.stdout?.on("data", (d) => {
        const text = d.toString();
        logOutput += text;
        if (text.includes(`:${PORT}`)) resolve();
      });
      syncProc.stderr?.on("data", (d) => {
        logOutput += d.toString();
      });
      syncProc.on("error", reject);
      setTimeout(resolve, 2500);
    });

    console.log("   -> Sync service started.\n");

    // 3. Test Task 1: GET /health
    console.log("[Task 1] Testing GET /health endpoint...");
    const healthRes = await fetch(`http://localhost:${PORT}/health`);
    const healthData = await healthRes.json() as any;
    console.log("   GET /health response:", JSON.stringify(healthData));

    if (!healthData.ok || healthData.nodeId !== NODE_ID) {
      throw new Error(`Invalid health response: expected nodeId='${NODE_ID}', got '${healthData.nodeId}'`);
    }
    console.log("   -> PASS: Task 1 verified (Node identity & /health response).\n");

    // 4. Test Task 0: Open 5 simultaneous connections to the persisted room
    console.log("[Task 0] Connecting 5 simultaneous clients right after startup...");
    const clientIds = [1, 2, 3, 4, 5].map((i) => `user-${i}-${uuidv4().slice(0, 6)}`);

    // Create room members so socket auth passes
    for (const uid of clientIds) {
      await prisma.user.create({ data: { id: uid, email: `${uid}@test.com`, name: uid } });
      await prisma.roomMember.create({ data: { roomId, userId: uid, role: "EDITOR" } });
    }

    // Connect all 5 at the exact same instant
    const t0 = Date.now();
    const connections = await Promise.all(
      clientIds.map((uid) => connectClient(PORT, roomId, uid))
    );
    const elapsed = Date.now() - t0;
    console.log(`   All 5 clients connected simultaneously in ${elapsed}ms.`);

    // Verify every client received the full persisted text
    let allFullText = true;
    connections.forEach(({ text }, idx) => {
      const match = text === sampleText;
      console.log(`   Client ${idx + 1} text length: ${text.length} bytes (matches persisted: ${match})`);
      if (!match) allFullText = false;
    });

    if (!allFullText) {
      throw new Error("One or more clients failed to receive the full persisted text due to room loading race!");
    }

    // Check /health shows 5 connected clients and 1 room
    const healthAfter = await (await fetch(`http://localhost:${PORT}/health`)).json() as any;
    console.log("   GET /health after 5 connections:", JSON.stringify(healthAfter));
    if (healthAfter.rooms !== 1 || healthAfter.clients !== 5) {
      throw new Error(`Expected rooms=1, clients=5; got rooms=${healthAfter.rooms}, clients=${healthAfter.clients}`);
    }

    // Verify logs contain [sync:NODE_ID] on connections and joins
    console.log("   Verifying nodeId appears in connection and join logs:");
    const logLines = logOutput.split("\n").filter((l) => l.includes(`[sync:${NODE_ID}]`));
    console.log(logLines.slice(0, 8).map((l) => `     ${l.trim()}`).join("\n"));

    if (logLines.length < 5) {
      throw new Error("Log output missing expected nodeId tags on connection/join lines!");
    }

    // Close sockets
    connections.forEach(({ ws }) => ws.close());
    await new Promise((r) => setTimeout(r, 600));

    console.log("   -> PASS: Task 0 verified (5 simultaneous connections received full persisted text).\n");
    console.log("=========================================================================");
    console.log("             TASKS 0 AND 1 COMPLETED AND VERIFIED SUCCESSFULLY           ");
    console.log("=========================================================================");

  } finally {
    killProc(syncProc);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});

