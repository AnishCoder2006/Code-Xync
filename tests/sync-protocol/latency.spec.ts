/**
 * Latency test: measures cross-node update propagation latency.
 * Sends 30 samples from Node 1 to Node 2, calculates p50 and p95 latency.
 */
import { test, expect } from "@playwright/test";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { prisma } from "../../services/api/src/lib/prisma";
import { v4 as uuidv4 } from "uuid";

const PORT_NODE1 = Number(process.env.PORT_NODE1 ?? 4041);
const PORT_NODE2 = Number(process.env.PORT_NODE2 ?? 4042);

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

test.describe("Cross-Node Latency Benchmark", () => {
  test("30 samples cross-node propagation latency (p50 and p95)", async () => {
    const roomId = "latency-" + uuidv4().slice(0, 8);
    const userA = "lat-a-" + uuidv4().slice(0, 4);
    const userB = "lat-b-" + uuidv4().slice(0, 4);

    for (const u of [userA, userB]) {
      await prisma.user.upsert({
        where: { id: u },
        create: { id: u, email: `${u}@test.com`, name: u },
        update: {},
      });
    }
    await prisma.room.create({
      data: {
        id: roomId, title: "Latency Room", ownerId: userA,
        members: { create: [{ userId: userA, role: "OWNER" }, { userId: userB, role: "EDITOR" }] },
      },
    });

    const clientA = await connectClient(PORT_NODE1, roomId, userA);
    const clientB = await connectClient(PORT_NODE2, roomId, userB);
    await wait(500);

    const latencies: number[] = [];
    const NUM_SAMPLES = 30;

    for (let i = 0; i < NUM_SAMPLES; i++) {
      const marker = `/* sample_${i}_${Date.now()} */\n`;
      const t0 = performance.now();

      const receivedPromise = new Promise<number>((resolve) => {
        const onUpdate = () => {
          if (clientB.doc.getText("content").toString().includes(marker)) {
            clientB.doc.off("update", onUpdate);
            resolve(performance.now() - t0);
          }
        };
        clientB.doc.on("update", onUpdate);
      });

      clientA.doc.getText("content").insert(clientA.doc.getText("content").length, marker);
      const elapsed = await receivedPromise;
      latencies.push(elapsed);
      await wait(50); // slight spacing between samples
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const avg = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;

    console.log("\n=======================================================");
    console.log("       CROSS-NODE LATENCY BENCHMARK RESULTS            ");
    console.log("=======================================================");
    console.log(`Conditions: Node 1 (:4041) -> Redis PubSub (:6380) -> Node 2 (:4042)`);
    console.log(`Samples:     ${NUM_SAMPLES}`);
    console.log(`Min:         ${min.toFixed(2)} ms`);
    console.log(`Average:     ${avg.toFixed(2)} ms`);
    console.log(`p50:         ${p50.toFixed(2)} ms`);
    console.log(`p95:         ${p95.toFixed(2)} ms`);
    console.log(`Max:         ${max.toFixed(2)} ms`);
    console.log("=======================================================\n");

    expect(p50).toBeLessThan(100); // Expect sub-100ms on localhost Redis
    expect(p95).toBeLessThan(250);

    clientA.ws.close();
    clientB.ws.close();
  });
});
