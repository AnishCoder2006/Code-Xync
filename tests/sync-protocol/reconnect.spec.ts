/**
 * Reconnect test: client goes offline, peer edits continue, client reconnects
 * and catches up.
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

test.describe("Reconnect", () => {
  test("client reconnects after disconnect and catches up with edits", async () => {
    const roomId = "recon-" + uuidv4().slice(0, 8);
    const userA = "recon-a-" + uuidv4().slice(0, 4);
    const userB = "recon-b-" + uuidv4().slice(0, 4);

    for (const u of [userA, userB]) {
      await prisma.user.upsert({
        where: { id: u },
        create: { id: u, email: `${u}@test.com`, name: u },
        update: {},
      });
    }
    await prisma.room.create({
      data: {
        id: roomId, title: "Reconnect Room", ownerId: userA,
        members: { create: [{ userId: userA, role: "OWNER" }, { userId: userB, role: "EDITOR" }] },
      },
    });

    // 1. Both connect, A writes initial text
    let clientA = await connectClient(PORT_NODE1, roomId, userA);
    const clientB = await connectClient(PORT_NODE2, roomId, userB);
    await wait(500);

    clientA.doc.getText("content").insert(0, "Before disconnect\n");
    await wait(600);
    expect(clientB.doc.getText("content").toString()).toContain("Before disconnect");

    // 2. A disconnects (simulating offline)
    clientA.ws.close();
    await wait(500);

    // 3. B edits while A is offline
    clientB.doc.getText("content").insert(clientB.doc.getText("content").length, "While A was offline\n");
    await wait(600);

    // 4. A reconnects (new WebSocket, new Y.Doc that syncs from server)
    clientA = await connectClient(PORT_NODE1, roomId, userA);
    await wait(1000);

    const textA = clientA.doc.getText("content").toString();
    console.log(`  Reconnected A sees: "${textA.trim()}"`);

    expect(textA).toContain("Before disconnect");
    expect(textA).toContain("While A was offline");

    clientA.ws.close();
    clientB.ws.close();
  });
});
