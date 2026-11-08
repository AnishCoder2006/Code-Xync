process.env.NODE_ENV = "test";

import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../services/sync/src/lib/prisma";

function killProcessTree(proc: ChildProcess | null) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {}
}

async function waitForHealth(url: string, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const SYNC_PORT = 4097;
const AI_URL = "http://localhost:8000";

async function runE2ESyncSearchTest() {
  console.log("=============================================================");
  console.log("    End-to-End Test: Sync WebSocket -> 5s Idle -> /search    ");
  console.log("=============================================================\n");

  const userId = "test-e2e-user-" + uuidv4().slice(0, 8);
  const roomId = "test-e2e-room-" + uuidv4().slice(0, 8);
  const token = `test-token-${userId}`;

  let syncProcess: ChildProcess | null = null;
  let aiProcess: ChildProcess | null = null;

  try {
    // 1. Seed user and room in PostgreSQL
    console.log(`[Step 1] Creating test room ${roomId} and user ${userId}...`);
    await prisma.user.create({
      data: { id: userId, email: `${userId}@test.com`, name: "E2E Sync Tester" },
    });

    await prisma.room.create({
      data: {
        id: roomId,
        title: "E2E Search Room",
        ownerId: userId,
        defaultLang: "typescript",
        members: {
          create: [{ userId, role: "OWNER" }],
        },
      },
    });

    // 2. Start Sync service on SYNC_PORT
    console.log(`[Step 2] Starting sync service on port ${SYNC_PORT}...`);
    await new Promise<void>((resolve, reject) => {
      syncProcess = spawn("npx", ["tsx", "services/sync/src/index.ts"], {
        env: {
          ...process.env,
          NODE_ENV: "test",
          SYNC_PORT: String(SYNC_PORT),
          REDIS_URL: "redis://localhost:6380",
        },
        stdio: "pipe",
        shell: true,
      });

      const timeout = setTimeout(() => reject(new Error("Sync service startup timeout")), 20000);

      syncProcess.stdout?.on("data", (d) => {
        const str = d.toString();
        if (str.includes("Sync service running on")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      syncProcess.on("error", reject);
    });
    console.log(`Sync service running on port ${SYNC_PORT}.`);

    // 3. Start AI service (runs background stream:ai_indexing consumer)
    console.log(`[Step 3] Checking/Starting AI service at ${AI_URL}...`);
    const aiAlreadyUp = await waitForHealth(AI_URL, 1500);
    if (!aiAlreadyUp) {
      const pythonPath = require("path").resolve(process.cwd(), "services/ai/.venv/Scripts/python.exe");
      aiProcess = spawn(`"${pythonPath}"`, ["-m", "uvicorn", "app.main:app", "--port", "8000"], {
        cwd: require("path").resolve(process.cwd(), "services/ai"),
        env: {
          ...process.env,
          REDIS_URL: "redis://localhost:6380",
          QDRANT_URL: "http://localhost:6333",
        },
        stdio: "pipe",
        shell: true,
      });

      aiProcess.stdout?.on("data", (d) => console.log(`[ai-out] ${d.toString().trim()}`));
      aiProcess.stderr?.on("data", (d) => console.error(`[ai-err] ${d.toString().trim()}`));

      const healthy = await waitForHealth(AI_URL, 30000);
      if (!healthy) throw new Error("AI service failed to become healthy");
    }
    console.log(`AI service healthy at ${AI_URL}.`);

    // 4. Connect WebSocket client and insert code into doc
    console.log("\n[Step 4] Connecting WebSocket client and typing function into doc...");
    const uniqueFn = "calculateOrbitalVelocity_" + uuidv4().slice(0, 6);
    const codeToType = `
export function ${uniqueFn}(mass: number, radius: number): number {
  const G = 6.67430e-11;
  return Math.sqrt((G * mass) / radius);
}
`;

    const clientDoc = new Y.Doc();
    await new Promise<void>((resolve, reject) => {
      const wsUrl = `ws://localhost:${SYNC_PORT}?token=${token}&roomId=${roomId}`;
      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeSyncStep1(encoder, clientDoc);
        ws.send(encoding.toUint8Array(encoder));
      });

      ws.on("message", (raw: Buffer) => {
        const data = new Uint8Array(raw);
        const decoder = decoding.createDecoder(data);
        const msgType = decoding.readVarUint(decoder);

        if (msgType === 0) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, 0);
          const syncReply = syncProtocol.readSyncMessage(decoder, encoder, clientDoc, null);

          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }

          if (syncReply === syncProtocol.messageYjsSyncStep2 || syncReply === 2) {
            // Document synced! Now type our function
            clientDoc.on("update", (update) => {
              const enc = encoding.createEncoder();
              encoding.writeVarUint(enc, 0);
              syncProtocol.writeUpdate(enc, update);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encoding.toUint8Array(enc));
              }
            });

            const ytext = clientDoc.getText("content");
            ytext.insert(0, codeToType);
            console.log(`Typed function '${uniqueFn}' over WebSocket.`);

            // Keep connection alive for 1 second to ensure delivery
            setTimeout(() => {
              ws.close();
              resolve();
            }, 1000);
          }
        }
      });

      ws.on("error", reject);
    });

    // 5. Wait for the 5-second debounce timer + stream indexing
    console.log("\n[Step 5] Waiting 7 seconds for 5s debounce idle publish + AI indexing...");
    await new Promise((r) => setTimeout(r, 7000));

    // 6. Search for the function via /search
    console.log(`\n[Step 6] Searching for '${uniqueFn}' in room '${roomId}'...`);
    const searchRes = await fetch(`${AI_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId,
        query: uniqueFn,
        limit: 5,
      }),
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      throw new Error(`Search failed with status ${searchRes.status}: ${errText}`);
    }

    const searchData: any = await searchRes.json();
    console.log("Search response:", JSON.stringify(searchData, null, 2));

    const hits = Array.isArray(searchData) ? searchData : (searchData.results || []);
    if (hits.length === 0) {
      throw new Error(`Expected search to return results, but got 0 hits`);
    }

    const topHit = hits[0];
    console.log(`Top hit function name: '${topHit.function_name}' (score: ${topHit.score})`);

    if (topHit.function_name !== uniqueFn) {
      throw new Error(`Expected top hit function '${uniqueFn}', but got '${topHit.function_name}'`);
    }

    console.log("\n PASS: Function typed over WebSocket was automatically indexed and found by /search!");

  } finally {
    console.log("\n[Cleanup] Tearing down test processes and DB records...");
    killProcessTree(syncProcess);
    killProcessTree(aiProcess);

    try {
      await prisma.projectFile.deleteMany({ where: { roomId } });
      await prisma.roomMember.deleteMany({ where: { roomId } });
      await prisma.room.deleteMany({ where: { id: roomId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    } catch {}
  }
}

runE2ESyncSearchTest()
  .then(() => {
    console.log("End-to-End test completed successfully.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("End-to-End test failed:", err);
    process.exit(1);
  });
