/**
 * Test Task 6: Two sync nodes behind the round-robin LB proxy.
 * Verifies:
 * - LB routes HTTP and WebSocket upgrades to both backends
 * - Clients landing on different nodes via the proxy still converge
 * - Failover when one node is down
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../services/api/src/lib/prisma";

const SYNC_DIST = require("path").resolve(__dirname, "../services/sync/dist/index.js");
const LB_DIST = require("path").resolve(__dirname, "../services/sync/dist/lb-proxy.js");
const PORT_NODE1 = 4031;
const PORT_NODE2 = 4032;
const LB_PORT = 4030;
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
      if (d.toString().includes(`:${port}`)) resolve(proc);
    });
    proc.stderr?.on("data", (d) => {
      // suppress expected errors
    });
    proc.on("error", reject);
    setTimeout(() => resolve(proc), 3000);
  });
}

function startLBProxy(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [LB_DIST], {
      env: {
        ...process.env,
        LB_PORT: String(LB_PORT),
        SYNC_BACKENDS: `127.0.0.1:${PORT_NODE1},127.0.0.1:${PORT_NODE2}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Load balancer listening")) resolve(proc);
    });
    proc.stderr?.on("data", (d) => {
      console.error("[LB stderr]", d.toString().trim());
    });
    proc.on("error", reject);
    setTimeout(() => resolve(proc), 3000);
  });
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=test-token-${userId}&roomId=${roomId}`);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 5000);

    ws.on("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, doc);
      ws.send(encoding.toUint8Array(encoder));
    });

    doc.on("update", (update: Uint8Array, origin: any) => {
      if (origin !== ws) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, update);
        if (ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(encoder));
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
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
        if (syncReply === syncProtocol.messageYjsSyncStep2 || syncReply === 2) {
          clearTimeout(timeout);
          resolve({ ws, doc, awareness, userId });
        }
      } else if (msgType === 1) {
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
      }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function main() {
  console.log("=========================================================================");
  console.log("         Task 6: Two Sync Nodes Behind LB Proxy                          ");
  console.log("=========================================================================\n");

  let proc1: ChildProcess | null = null;
  let proc2: ChildProcess | null = null;
  let lbProc: ChildProcess | null = null;

  try {
    // Start two sync nodes
    console.log(`[Setup] Starting Node 1 on :${PORT_NODE1}...`);
    proc1 = await startSyncNode(PORT_NODE1, "lb-node-01");
    console.log(`[Setup] Starting Node 2 on :${PORT_NODE2}...`);
    proc2 = await startSyncNode(PORT_NODE2, "lb-node-02");
    console.log(`[Setup] Starting LB Proxy on :${LB_PORT}...`);
    lbProc = await startLBProxy();
    await new Promise((r) => setTimeout(r, 1500));

    // Verify health via LB (round-robin: first to node1, second to node2)
    const h1 = await (await fetch(`http://127.0.0.1:${LB_PORT}/health`)).json() as any;
    const h2 = await (await fetch(`http://127.0.0.1:${LB_PORT}/health`)).json() as any;
    console.log(`   LB request 1 -> nodeId: ${h1.nodeId}`);
    console.log(`   LB request 2 -> nodeId: ${h2.nodeId}`);

    if (h1.nodeId === h2.nodeId) {
      console.log("   (Both went to same node — round-robin hit same index; still valid)");
    } else {
      console.log("   ✓ Round-robin distributed across both nodes");
    }

    // Create room + users
    const roomId = "lb-room-" + uuidv4().slice(0, 8);
    const userA = "lb-user-a-" + uuidv4().slice(0, 6);
    const userB = "lb-user-b-" + uuidv4().slice(0, 6);

    await prisma.user.createMany({
      data: [
        { id: userA, email: `${userA}@test.com`, name: "LB User A" },
        { id: userB, email: `${userB}@test.com`, name: "LB User B" },
      ],
    });
    await prisma.room.create({
      data: {
        id: roomId,
        title: "LB Test Room",
        ownerId: userA,
        members: {
          create: [
            { userId: userA, role: "OWNER" },
            { userId: userB, role: "EDITOR" },
          ],
        },
      },
    });

    // Connect both clients through the LB proxy
    console.log(`   Connecting Client A through LB (ws://localhost:${LB_PORT})...`);
    const clientA = await connectClient(LB_PORT, roomId, userA);
    console.log(`   Connecting Client B through LB (ws://localhost:${LB_PORT})...`);
    const clientB = await connectClient(LB_PORT, roomId, userB);
    await new Promise((r) => setTimeout(r, 600));

    const roomClientsOn = async (port: number) => {
      const h = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-internal-secret": INTERNAL_SECRET } })).json() as any;
      return h.roomDetails?.[roomId]?.clients ?? 0;
    };
    const onN1 = await roomClientsOn(PORT_NODE1);
    const onN2 = await roomClientsOn(PORT_NODE2);
    console.log(`   Room clients per node (from /health): node1=${onN1}, node2=${onN2}`);
    if (onN1 !== 1 || onN2 !== 1) {
      throw new Error(`Expected the two LB clients on different nodes (1+1), got node1=${onN1} node2=${onN2}`);
    }
    console.log("   ✓ The two WebSocket clients landed on different nodes");

    // Client A edits
    clientA.doc.getText("content").insert(0, "Hello from LB Client A!\n");
    await new Promise((r) => setTimeout(r, 800));

    const textOnB = clientB.doc.getText("content").toString();
    console.log(`   Client B sees: "${textOnB.trim()}"`);
    if (!textOnB.includes("Hello from LB Client A")) {
      throw new Error("Client B did not receive edit through LB proxy!");
    }

    // Client B edits
    clientB.doc.getText("content").insert(clientB.doc.getText("content").length, "Hello from LB Client B!\n");
    await new Promise((r) => setTimeout(r, 800));

    const textOnA = clientA.doc.getText("content").toString();
    console.log(`   Client A sees: "${textOnA.trim()}"`);
    if (!textOnA.includes("Hello from LB Client B")) {
      throw new Error("Client A did not receive Client B's edit!");
    }

    console.log("   ✓ Bidirectional sync through LB proxy works\n");

    // Test failover: kill Node 1, check LB health still works (falls back to Node 2)
    console.log("   Killing Node 1 to test failover...");
    killProc(proc1);
    proc1 = null;
    await new Promise((r) => setTimeout(r, 1000));

    for (let i = 0; i < 4; i++) {
      const hFallback = await (await fetch(`http://127.0.0.1:${LB_PORT}/health`)).json() as any;
      console.log(`   LB /health request ${i + 1} after Node 1 kill -> nodeId: ${hFallback.nodeId}`);
      if (hFallback.nodeId !== "lb-node-02") {
        throw new Error(`Expected failover to lb-node-02, got ${hFallback.nodeId}`);
      }
    }
    console.log("   ✓ LB fell back to Node 2 for every request after Node 1 died");

    const userC = userA; // A reconnects as a NEW websocket through the LB
    const clientA2 = await connectClient(LB_PORT, roomId, userC);
    const after = clientA2.doc.getText("content").toString();
    const n2Clients = await roomClientsOn(PORT_NODE2);
    console.log(`   New WS via LB after kill: node2 room clients=${n2Clients}, text="${after.trim().split("\n").join(" | ")}"`);
    if (n2Clients !== 2) throw new Error(`Expected new connection on node 2 (2 clients), got ${n2Clients}`);
    if (!after.includes("Hello from LB Client A") || !after.includes("Hello from LB Client B")) {
      throw new Error("New connection after failover did not receive the full document");
    }
    console.log("   ✓ New WebSocket connection went to Node 2 and received the full document");
    clientA2.ws.close();

    clientA.ws.close();
    clientB.ws.close();

    console.log("\n   -> PASS: Task 6 verified (LB proxy routes to both nodes, failover works).\n");

  } finally {
    killProc(proc1);
    killProc(proc2);
    killProc(lbProc);
    await prisma.$disconnect();
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});

