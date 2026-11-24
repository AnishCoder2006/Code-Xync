/**
 * Convergence test: 3 clients on different nodes, concurrent typing, text convergence.
 *
 * Uses direct WebSocket connections through the LB proxy to prove that edits
 * made by any client reach all others and the final text is identical.
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

const LB_PORT = Number(process.env.LB_PORT ?? 4040);
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

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

test.describe("Convergence", () => {
  test("3 clients on mixed nodes converge after concurrent edits", async () => {
    const roomId = "conv-" + uuidv4().slice(0, 8);
    const users = ["conv-a-" + uuidv4().slice(0, 4), "conv-b-" + uuidv4().slice(0, 4), "conv-c-" + uuidv4().slice(0, 4)];

    // Seed
    for (const u of users) {
      await prisma.user.upsert({
        where: { id: u },
        create: { id: u, email: `${u}@test.com`, name: u },
        update: {},
      });
    }
    await prisma.room.create({
      data: {
        id: roomId,
        title: "Convergence Room",
        ownerId: users[0],
        members: { create: users.map((u, i) => ({ userId: u, role: i === 0 ? "OWNER" : "EDITOR" })) },
      },
    });

    // Connect: A -> Node1 direct, B -> Node2 direct, C -> LB proxy
    const clientA = await connectClient(PORT_NODE1, roomId, users[0]);
    const clientB = await connectClient(PORT_NODE2, roomId, users[1]);
    const clientC = await connectClient(LB_PORT, roomId, users[2]);
    await wait(500);

    // All three type concurrently
    clientA.doc.getText("content").insert(0, "AAA\n");
    clientB.doc.getText("content").insert(0, "BBB\n");
    clientC.doc.getText("content").insert(0, "CCC\n");

    // Wait for convergence
    await wait(2000);

    const textA = clientA.doc.getText("content").toString();
    const textB = clientB.doc.getText("content").toString();
    const textC = clientC.doc.getText("content").toString();

    console.log(`  Client A text: "${textA.trim()}"`);
    console.log(`  Client B text: "${textB.trim()}"`);
    console.log(`  Client C text: "${textC.trim()}"`);

    // All must be identical (Yjs CRDT guarantees)
    expect(textA).toBe(textB);
    expect(textB).toBe(textC);

    // All must contain all three insertions
    expect(textA).toContain("AAA");
    expect(textA).toContain("BBB");
    expect(textA).toContain("CCC");

    clientA.ws.close();
    clientB.ws.close();
    clientC.ws.close();
  });

  test("5 simultaneous clients all receive full persisted text", async () => {
    const roomId = "conv5-" + uuidv4().slice(0, 8);
    const users = Array.from({ length: 5 }, (_, i) => `conv5-u${i}-${uuidv4().slice(0, 4)}`);

    for (const u of users) {
      await prisma.user.upsert({
        where: { id: u },
        create: { id: u, email: `${u}@test.com`, name: u },
        update: {},
      });
    }
    await prisma.room.create({
      data: {
        id: roomId,
        title: "5-Client Room",
        ownerId: users[0],
        members: { create: users.map((u, i) => ({ userId: u, role: i === 0 ? "OWNER" : "EDITOR" })) },
      },
    });

    // First client sets initial text
    const first = await connectClient(PORT_NODE1, roomId, users[0]);
    first.doc.getText("content").insert(0, "Initial content from first client.\n");
    await wait(600);
    first.ws.close();
    await wait(1000);

    // Connect all 5 simultaneously using Promise.all (alternating nodes)
    const clients = await Promise.all(
      users.map((u, i) => {
        const port = i % 2 === 0 ? PORT_NODE1 : PORT_NODE2;
        return connectClient(port, roomId, u);
      })
    );
    await wait(1000);

    // All should see the initial text
    for (const c of clients) {
      const text = c.doc.getText("content").toString();
      expect(text).toContain("Initial content from first client");
      c.ws.close();
    }
  });
});
