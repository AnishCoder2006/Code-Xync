/**
 * Node-kill test: kill one sync node, client reconnects to surviving node,
 * all edits preserved. A third client started after the kill sees complete text.
 */
import { test, expect } from "@playwright/test";
import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { prisma } from "../../services/api/src/lib/prisma";
import { v4 as uuidv4 } from "uuid";
import path from "path";

const SYNC_DIST = path.resolve(__dirname, "../../services/sync/dist/index.js");
const PORT_KILL_N1 = 4051;
const PORT_KILL_N2 = 4052;
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

test.describe("Node Kill", () => {
  test("kill node 1, client A reconnects to node 2, third client sees full doc", async () => {
    const roomId = "kill-" + uuidv4().slice(0, 8);
    const userA = "kill-a-" + uuidv4().slice(0, 4);
    const userB = "kill-b-" + uuidv4().slice(0, 4);
    const userC = "kill-c-" + uuidv4().slice(0, 4);

    for (const u of [userA, userB, userC]) {
      await prisma.user.upsert({
        where: { id: u },
        create: { id: u, email: `${u}@test.com`, name: u },
        update: {},
      });
    }
    await prisma.room.create({
      data: {
        id: roomId, title: "Kill Room", ownerId: userA,
        members: { create: [
          { userId: userA, role: "OWNER" },
          { userId: userB, role: "EDITOR" },
          { userId: userC, role: "EDITOR" },
        ]},
      },
    });

    // Start two private nodes for this test (separate ports from global setup)
    let proc1: ChildProcess | null = await startNode(PORT_KILL_N1, "kill-n1");
    const proc2: ChildProcess | null = await startNode(PORT_KILL_N2, "kill-n2");
    await wait(1500);

    try {
      // A on node 1, B on node 2
      const clientA = await connectClient(PORT_KILL_N1, roomId, userA);
      const clientB = await connectClient(PORT_KILL_N2, roomId, userB);
      await wait(500);

      clientA.doc.getText("content").insert(0, "Line from A on node1\n");
      clientB.doc.getText("content").insert(0, "Line from B on node2\n");
      await wait(1000);

      // Verify convergence before kill
      expect(clientA.doc.getText("content").toString()).toContain("Line from B on node2");
      expect(clientB.doc.getText("content").toString()).toContain("Line from A on node1");

      // Kill node 1
      console.log("  Killing node 1...");
      killProc(proc1);
      proc1 = null;
      await wait(1500);

      // B continues editing on node 2
      clientB.doc.getText("content").insert(clientB.doc.getText("content").length, "Added after node1 died\n");
      await wait(500);

      // A reconnects to node 2
      console.log("  Reconnecting A to node 2...");
      const clientA2 = await connectClient(PORT_KILL_N2, roomId, userA);
      await wait(1000);

      const textA2 = clientA2.doc.getText("content").toString();
      console.log(`  Reconnected A sees: "${textA2.trim()}"`);
      expect(textA2).toContain("Line from A on node1");
      expect(textA2).toContain("Line from B on node2");
      expect(textA2).toContain("Added after node1 died");

      // Third client C connects to node 2, sees everything
      const clientC = await connectClient(PORT_KILL_N2, roomId, userC);
      await wait(800);

      const textC = clientC.doc.getText("content").toString();
      console.log(`  New client C sees: "${textC.trim()}"`);
      expect(textC).toContain("Line from A on node1");
      expect(textC).toContain("Added after node1 died");

      clientA.ws.close();
      clientA2.ws.close();
      clientB.ws.close();
      clientC.ws.close();
    } finally {
      killProc(proc1);
      killProc(proc2);
    }
  });
});
