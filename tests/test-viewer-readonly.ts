// Plan step 2.5 (server side): a VIEWER connection can read the document and send
// presence, but its document writes are dropped by the sync node.
//
// Run: NODE_ENV=test npx tsx tests/test-viewer-readonly.ts   (needs services/sync/dist built)

process.env.NODE_ENV = "test";

import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import { randomUUID } from "crypto";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";
import { prisma } from "../services/api/src/lib/prisma";

const PORT = 4396;
const SYNC_DIST = path.resolve(__dirname, "../services/sync/dist/index.js");
const SECRET = "codesync-internal-ai-secret";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? "\n        " + JSON.stringify(detail) : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(roomId: string, uid: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}`, roomId, doc, {
    WebSocketPolyfill: WS as any,
    params: { token: `test-token-${uid}`, roomId },
    disableBc: true,
  });
  const synced = new Promise<void>((r) => provider.once("sync", () => r()));
  return { doc, provider, synced };
}

async function main() {
  const tag = randomUUID().slice(0, 8);
  const owner = `ro-owner-${tag}`;
  const viewer = `ro-viewer-${tag}`;
  const roomId = `ro-room-${tag}`;
  let node: ChildProcess | null = null;
  const clients: WebsocketProvider[] = [];
  try {
    await prisma.user.createMany({ data: [owner, viewer].map((id) => ({ id, email: `${id}@test.local`, name: id })) });
    await prisma.room.create({
      data: {
        id: roomId, title: roomId, ownerId: owner,
        members: { create: [{ userId: owner, role: "OWNER" }, { userId: viewer, role: "VIEWER" }] },
      },
    });

    node = spawn(process.execPath, [SYNC_DIST], {
      env: { ...process.env, SYNC_PORT: String(PORT), NODE_ID: "ro-node", NODE_ENV: "test", INTERNAL_API_SECRET: SECRET },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("sync node did not start")), 15000);
      node!.stdout!.on("data", (d) => { if (String(d).includes(`running on :${PORT}`)) { clearTimeout(t); resolve(); } });
    });

    const a = connect(roomId, owner);
    const v = connect(roomId, viewer);
    clients.push(a.provider, v.provider);
    await Promise.all([a.synced, v.synced]);

    a.doc.getText("content").insert(0, "owner text\n");
    await wait(500);
    check("viewer receives the owner's edit (read works)", v.doc.getText("content").toString() === "owner text\n",
      v.doc.getText("content").toString());

    v.doc.getText("content").insert(0, "VIEWER WRITE\n");
    await wait(800);
    check("owner never receives the viewer's write", a.doc.getText("content").toString() === "owner text\n",
      a.doc.getText("content").toString());

    const text = await (await fetch(`http://127.0.0.1:${PORT}/room/${roomId}/text`, { headers: { "x-internal-secret": SECRET } })).json();
    check("server document has no viewer write", text.content === "owner text\n", text.content);

    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    check("node counts dropped viewer updates", health.viewer?.droppedUpdates >= 1, health.viewer);

    // A fresh client (owner, second tab) loads the server state: no viewer text there either.
    const a2 = connect(roomId, owner);
    clients.push(a2.provider);
    await a2.synced;
    await wait(300);
    check("fresh client sees no viewer text", a2.doc.getText("content").toString() === "owner text\n",
      a2.doc.getText("content").toString());

    v.provider.awareness.setLocalStateField("user", { name: "Viewer", userId: viewer });
    await wait(500);
    const seen = [...a.provider.awareness.getStates().values()].some((s: any) => s.user?.userId === viewer);
    check("viewer presence (awareness) still reaches the owner", seen);
  } finally {
    clients.forEach((p) => p.destroy());
    if (node?.pid) {
      try {
        if (process.platform === "win32") execSync(`taskkill /pid ${node.pid} /T /F`, { stdio: "ignore" });
        else node.kill("SIGKILL");
      } catch {}
    }
    await prisma.projectFile.deleteMany({ where: { roomId } });
    await prisma.roomMember.deleteMany({ where: { roomId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: { in: [owner, viewer] } } });
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
