/**
 * Test Task A3: Redis restart anti-entropy convergence.
 * With connected clients on two nodes:
 * 1. Stop Redis (docker stop docker-redis-1)
 * 2. Edit on node 1
 * 3. Start Redis (docker start docker-redis-1)
 * 4. Within 20s the CLIENT on node 2 must show the edit with NO reconnect.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { prisma } from "../services/api/src/lib/prisma";

const SYNC_DIST = path.resolve(__dirname, "../services/sync/dist/index.js");
const PORT_NODE1 = 4061;
const PORT_NODE2 = 4062;
const INTERNAL_SECRET = "codesync-internal-ai-secret";

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

function startNode(port: number, nodeId: string): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const proc = spawn("node", [SYNC_DIST], {
      env: {
        ...process.env,
        SYNC_PORT: String(port),
        PORT: String(port),
        NODE_ID: nodeId,
        NODE_ENV: "test",
        INTERNAL_API_SECRET: INTERNAL_SECRET,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => {
      if (d.toString().includes(`:${port}`)) resolve(proc);
    });
    proc.stderr?.on("data", () => {});
    setTimeout(() => resolve(proc), 4000);
  });
}

interface Client {
  ws: WebSocket;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  userId: string;
}

function connectClient(port: number, roomId: string, userId: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const ws = new WebSocket(`ws://localhost:${port}?token=test-token-${userId}&roomId=${roomId}`);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 8000);

    ws.on("open", () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, doc);
      ws.send(encoding.toUint8Array(enc));
    });

    doc.on("update", (update: Uint8Array, origin: any) => {
      if (origin !== ws) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.writeUpdate(enc, update);
        if (ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(enc));
      }
    });

    ws.on("message", (raw: Buffer) => {
      const data = new Uint8Array(raw);
      const dec = decoding.createDecoder(data);
      const msgType = decoding.readVarUint(dec);
      if (msgType === 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        const syncReply = syncProtocol.readSyncMessage(dec, enc, doc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        if (syncReply === syncProtocol.messageYjsSyncStep2 || syncReply === 2) {
          clearTimeout(timeout);
          resolve({ ws, doc, awareness, userId });
        }
      } else if (msgType === 1) {
        const update = decoding.readVarUint8Array(dec);
        awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
      }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log("=========================================================================");
  console.log("         Task A3: Redis Restart Anti-Entropy Convergence                 ");
  console.log("=========================================================================\n");

  let proc1: ChildProcess | null = null;
  let proc2: ChildProcess | null = null;

  try {
    console.log(`[Setup] Starting Node 1 on :${PORT_NODE1}...`);
    proc1 = await startNode(PORT_NODE1, "redis-test-n1");
    console.log(`[Setup] Starting Node 2 on :${PORT_NODE2}...`);
    proc2 = await startNode(PORT_NODE2, "redis-test-n2");
    await wait(1500);

    const roomId = "redis-restart-room-" + uuidv4().slice(0, 8);
    const userA = "user-a-" + uuidv4().slice(0, 4);
    const userB = "user-b-" + uuidv4().slice(0, 4);

    await prisma.user.upsert({
      where: { id: userA },
      create: { id: userA, email: `${userA}@test.com`, name: userA },
      update: {},
    });
    await prisma.user.upsert({
      where: { id: userB },
      create: { id: userB, email: `${userB}@test.com`, name: userB },
      update: {},
    });
    await prisma.room.create({
      data: {
        id: roomId, title: "Redis Restart Room", ownerId: userA,
        members: { create: [{ userId: userA, role: "OWNER" }, { userId: userB, role: "EDITOR" }] },
      },
    });

    console.log("   Connecting Client A to Node 1 and Client B to Node 2...");
    const clientA = await connectClient(PORT_NODE1, roomId, userA);
    const clientB = await connectClient(PORT_NODE2, roomId, userB);
    const wsBAtStart = clientB.ws; // must be the very same socket at the end (no reconnect)
    let bSocketCloses = 0;
    clientB.ws.on("close", () => bSocketCloses++);
    const relay = async (port: number) => ((await (await fetch(`http://localhost:${port}/health`)).json()) as any).relay;
    await wait(1000);

    // Initial baseline sync
    clientA.doc.getText("content").insert(0, "Baseline before Redis stop\n");
    await wait(800);
    expectText(clientB.doc.getText("content").toString(), "Baseline before Redis stop", "Initial sync");

    // 1. Stop Redis
    console.log("   Stopping Redis container (docker stop docker-redis-1)...");
    execSync("docker stop docker-redis-1", { stdio: "inherit" });
    await wait(2000);

    // 2. Edit on Node 1 while Redis is down
    const offlineEdit = "Edit made while Redis was down!";
    console.log(`   Client A editing on Node 1: '${offlineEdit}'...`);
    clientA.doc.getText("content").insert(clientA.doc.getText("content").length, offlineEdit + "\n");
    await wait(1000);

    // Verify Client B has NOT received it yet because Redis is down
    const textBDuring = clientB.doc.getText("content").toString();
    console.log(`   Client B text while Redis is down: "${textBDuring.trim()}"`);

    const n1BeforeRestart = await relay(PORT_NODE1);
    const n2BeforeRestart = await relay(PORT_NODE2);
    // 3. Start Redis
    console.log("   Starting Redis container (docker start docker-redis-1)...");
    execSync("docker start docker-redis-1", { stdio: "inherit" });
    console.log("   Waiting up to 20s for anti-entropy sync to deliver update to Client B...");

    // 4. Poll Client B without reconnecting! (Max 20s)
    const t0 = Date.now();
    let converged = false;
    while (Date.now() - t0 < 20000) {
      const currentText = clientB.doc.getText("content").toString();
      if (currentText.includes(offlineEdit)) {
        converged = true;
        const elapsed = (Date.now() - t0) / 1000;
        console.log(`\n   ✓ SUCCESS: Client B received edit via anti-entropy in ${elapsed.toFixed(1)}s (no reconnect)!`);
        console.log(`   Client B content:\n   "${currentText.trim()}"\n`);
        break;
      }
      await wait(500);
    }

    if (converged) {
      await wait(500);
      const n1 = await relay(PORT_NODE1);
      const n2 = await relay(PORT_NODE2);
      const d = (a: any, b: any, k: string) => b[k] - a[k];
      console.log("   Relay stats during the outage window (node1 / node2):");
      for (const k of ["publishFailures", "publishedUpdates", "syncRequestsSent", "syncRepliesSent", "syncRepliesSkippedNoNewData", "syncRepliesApplied", "redisReconnects"]) {
        console.log(`     ${k.padEnd(28)} node1=${n1[k]}  node2=${n2[k]}   (since restart: +${d(n1BeforeRestart, n1, k)} / +${d(n2BeforeRestart, n2, k)})`);
      }
      const checks: Array<[boolean, string]> = [
        [n1.publishFailures >= 1, "node 1 could not publish the offline edit (publisher has no offline queue)"],
        [n2.syncRepliesApplied - n2BeforeRestart.syncRepliesApplied >= 1, "node 2 applied an anti-entropy reply after Redis came back"],
        [n2.publishedUpdates === n2BeforeRestart.publishedUpdates, "node 2 did NOT re-publish the applied redis-sync update"],
        [n1.syncRepliesSkippedNoNewData + n2.syncRepliesSkippedNoNewData >= 1, "anti-entropy replies with no new data were skipped"],
        [clientB.ws === wsBAtStart && bSocketCloses === 0 && clientB.ws.readyState === WebSocket.OPEN, "client B kept the same open socket (no reconnect)"],
      ];
      for (const [ok, label] of checks) console.log(`   ${ok ? "PASS" : "FAIL"}: ${label}`);
      if (checks.some(([ok]) => !ok)) throw new Error("A3 mechanism checks failed");
    }
    if (!converged) {
      throw new Error(`Client B did not receive edit within 20s after Redis restart! Text was: "${clientB.doc.getText("content").toString()}"`);
    }

    clientA.ws.close();
    clientB.ws.close();

    console.log("=========================================================================");
    console.log("   -> PASS: Task A3 verified (Redis restart anti-entropy delivered in <20s)");
    console.log("=========================================================================\n");

  } finally {
    // Ensure Redis is running
    try { execSync("docker start docker-redis-1", { stdio: "ignore" }); } catch {}
    killProc(proc1);
    killProc(proc2);
    await prisma.$disconnect();
  }
}

function expectText(actual: string, expected: string, label: string) {
  if (!actual.includes(expected)) {
    throw new Error(`[${label}] Expected "${expected}" in "${actual}"`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

