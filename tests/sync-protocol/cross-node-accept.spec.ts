/**
 * Cross-Node Accept test:
 * An AI fix is accepted via the API or sync HTTP endpoint, updating the document.
 * Editors/clients connected to both Node 1 and Node 2 observe the update immediately.
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
const INTERNAL_SECRET = "codesync-internal-ai-secret";

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

test.describe("Cross-Node Accept", () => {
  test("AI Accept applied via Node 1 propagates to Node 2 client in real time", async () => {
    const roomId = "accept-" + uuidv4().slice(0, 8);
    const userA = "accept-a-" + uuidv4().slice(0, 4);
    const userB = "accept-b-" + uuidv4().slice(0, 4);

    for (const u of [userA, userB]) {
      await prisma.user.upsert({
        where: { id: u },
        create: { id: u, email: `${u}@test.com`, name: u },
        update: {},
      });
    }
    await prisma.room.create({
      data: {
        id: roomId, title: "Accept Room", ownerId: userA,
        members: { create: [{ userId: userA, role: "OWNER" }, { userId: userB, role: "EDITOR" }] },
      },
    });

    const clientA = await connectClient(PORT_NODE1, roomId, userA);
    const clientB = await connectClient(PORT_NODE2, roomId, userB);
    await wait(500);

    // Initial buggy code
    const initialCode = "function add(a, b) {\n  return a - b;\n}\n";
    clientA.doc.getText("content").insert(0, initialCode);
    await wait(600);

    expect(clientB.doc.getText("content").toString()).toContain("return a - b;");

    // Apply patch via Node 1 sync HTTP route
    const patchRes = await fetch(`http://localhost:${PORT_NODE1}/room/${roomId}/apply-patch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({
        oldRangeText: "return a - b;",
        newCode: "return a + b;",
      }),
    });

    expect(patchRes.status).toBe(200);
    const patchJson = await patchRes.json() as any;
    expect(patchJson.success).toBe(true);

    // Wait for both clients to receive the change
    await wait(800);

    const textA = clientA.doc.getText("content").toString();
    const textB = clientB.doc.getText("content").toString();

    console.log(`  Client A text: "${textA.trim()}"`);
    console.log(`  Client B text: "${textB.trim()}"`);

    expect(textA).toContain("return a + b;");
    expect(textB).toContain("return a + b;");
    expect(textA).not.toContain("return a - b;");
    expect(textB).not.toContain("return a - b;");

    clientA.ws.close();
    clientB.ws.close();
  });
});

