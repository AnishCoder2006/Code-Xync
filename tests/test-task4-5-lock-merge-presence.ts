/**
 * Week 4 Task 4 (lock + merge, exercised through the nodes' own save path) and
 * Task 5 (ghost presence expiry when a whole node dies).
 *
 *   NODE_ENV=test npx tsx tests/test-task4-5-lock-merge-presence.ts
 *
 * 4a merge-before-write: another writer stores state in Postgres that node 1 never saw
 *    (simulates a peer save whose relay was lost). When node 1 saves, the stored row must
 *    contain BOTH node 1's edit and the external one.
 * 4b lock respected: the save lock is held by "someone else" for 2.5s; node 1's
 *    last-client-leaves save must not write while it is held, and must write after.
 * 5  node death: client A (node 1) has presence; node 1 is killed hard. Client B on
 *    node 2 must stop seeing A within 40s (awareness outdated timeout is 30s).
 */
import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { prisma } from "../services/api/src/lib/prisma";

const SYNC_DIST = path.resolve(__dirname, "../services/sync/dist/index.js");
const P1 = 4071;
const P2 = 4072;
const SECRET = "codesync-internal-ai-secret";
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function killProc(p: ChildProcess | null) {
  if (!p?.pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: "ignore" });
    else p.kill("SIGKILL");
  } catch {}
}

function startNode(port: number, nodeId: string): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const p = spawn("node", [SYNC_DIST], {
      env: { ...process.env, SYNC_PORT: String(port), NODE_ID: nodeId, NODE_ENV: "test", INTERNAL_API_SECRET: SECRET },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout?.on("data", (d) => d.toString().includes(`:${port}`) && resolve(p));
    setTimeout(() => resolve(p), 4000);
  });
}

interface Client { ws: WebSocket; doc: Y.Doc; awareness: awarenessProtocol.Awareness; mute: () => void }

function connect(port: number, roomId: string, userId: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const ws = new WebSocket(`ws://localhost:${port}?token=test-token-${userId}&roomId=${roomId}`);
    let muted = false;
    const t = setTimeout(() => reject(new Error("connect timeout")), 8000);
    ws.on("open", () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, doc);
      ws.send(encoding.toUint8Array(e));
    });
    doc.on("update", (u: Uint8Array, origin: any) => {
      if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, u);
      ws.send(encoding.toUint8Array(e));
    });
    awareness.on("update", ({ added, updated, removed }: any, origin: any) => {
      if (muted || origin === ws || ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 1);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed)));
      ws.send(encoding.toUint8Array(e));
    });
    ws.on("message", (raw: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(raw));
      const type = decoding.readVarUint(dec);
      if (type === 0) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        const r = syncProtocol.readSyncMessage(dec, e, doc, ws);
        if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
        if (r === syncProtocol.messageYjsSyncStep2) {
          clearTimeout(t);
          resolve({
            ws, doc, awareness,
            // Stop sending anything (no heartbeat, no removal) without closing the socket.
            mute: () => { muted = true; clearInterval((awareness as any)._checkInterval); },
          });
        }
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      }
    });
    ws.on("error", reject);
  });
}

async function seedRoom(roomId: string, users: string[]) {
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u }, create: { id: u, email: `${u}@test.com`, name: u }, update: {} });
  }
  await prisma.room.create({
    data: {
      id: roomId, title: roomId, ownerId: users[0],
      members: { create: users.map((u, i) => ({ userId: u, role: i === 0 ? "OWNER" : "EDITOR" })) },
    },
  });
}

const storedText = async (roomId: string) => {
  const f = await prisma.projectFile.findFirst({ where: { roomId } });
  const d = new Y.Doc();
  if (f?.yjsState?.length) Y.applyUpdate(d, new Uint8Array(f.yjsState));
  return { text: d.getText("content").toString(), updatedAt: f?.updatedAt };
};

const health = async (port: number) => (await fetch(`http://localhost:${port}/health`)).json() as Promise<any>;

async function main() {
  let n1: ChildProcess | null = null;
  let n2: ChildProcess | null = null;
  let failed = false;
  const check = (cond: boolean, label: string) => {
    console.log(`   ${cond ? "PASS" : "FAIL"}: ${label}`);
    if (!cond) failed = true;
  };
  try {
    n1 = await startNode(P1, "t45-node-01");
    n2 = await startNode(P2, "t45-node-02");
    await wait(800);

    // ── 4a merge-before-write ─────────────────────────────────────────────
    console.log("\n[4a] merge-before-write through the node's save path");
    const roomA = "t4-merge-" + uuidv4().slice(0, 8);
    const ua = "t4a-" + uuidv4().slice(0, 6);
    await seedRoom(roomA, [ua]);
    const a = await connect(P1, roomA, ua);
    a.doc.getText("content").insert(0, "NODE1_EDIT\n");
    await wait(300);
    // Another writer stores state node 1 never received over Redis.
    const row = await prisma.projectFile.findFirst({ where: { roomId: roomA } });
    const ext = new Y.Doc();
    if (row?.yjsState?.length) Y.applyUpdate(ext, new Uint8Array(row.yjsState));
    ext.getText("content").insert(0, "EXTERNAL_WRITER_EDIT\n");
    await prisma.projectFile.update({ where: { id: row!.id }, data: { yjsState: Buffer.from(Y.encodeStateAsUpdate(ext)) } });
    console.log("   stored by external writer:", JSON.stringify((await storedText(roomA)).text));
    a.ws.close(); // last client leaves -> save under lock with merge
    await wait(1500);
    const s4a = await storedText(roomA);
    console.log("   stored after node 1 saved:", JSON.stringify(s4a.text));
    check(s4a.text.includes("NODE1_EDIT") && s4a.text.includes("EXTERNAL_WRITER_EDIT"),
      "stored state contains both node 1's edit and the external writer's edit (no overwrite)");
    const h1 = await health(P1);
    console.log(`   node 1 persistence stats: ${JSON.stringify(h1.persistence)}`);
    check(h1.persistence.dbMergesWithNewData >= 1, "node 1 reports a db-merge that brought in new data");

    // ── 4b lock respected ─────────────────────────────────────────────────
    console.log("\n[4b] node 1 waits while the save lock is held elsewhere");
    const roomB = "t4-lock-" + uuidv4().slice(0, 8);
    const ub = "t4b-" + uuidv4().slice(0, 6);
    await seedRoom(roomB, [ub]);
    const b = await connect(P1, roomB, ub);
    b.doc.getText("content").insert(0, "EDIT_DURING_LOCK\n");
    await wait(300);
    const lockKey = `lock:room:${roomB}:save`;
    const held = await redis.set(lockKey, "someone-else", "PX", 2500, "NX");
    console.log(`   external holder took ${lockKey}: ${held}`);
    const tLock = Date.now();
    b.ws.close();
    await wait(1200);
    const during = await storedText(roomB);
    console.log(`   at +${Date.now() - tLock}ms (lock held): stored=${JSON.stringify(during.text)}`);
    check(!during.text.includes("EDIT_DURING_LOCK"), "no write while the lock was held by another owner");
    let after = during;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      after = await storedText(roomB);
      if (after.text.includes("EDIT_DURING_LOCK")) break;
      await wait(200);
    }
    console.log(`   at +${Date.now() - tLock}ms: stored=${JSON.stringify(after.text)}`);
    check(after.text.includes("EDIT_DURING_LOCK"), "write happened after the lock expired (2500ms)");
    check(Date.now() - tLock >= 2400, "write was not earlier than the lock expiry");

    // ── 5 node death presence expiry ──────────────────────────────────────
    console.log("\n[5] whole node dies: ghost presence must expire");
    const roomC = "t5-ghost-" + uuidv4().slice(0, 8);
    const uA = "t5a-" + uuidv4().slice(0, 6);
    const uB = "t5b-" + uuidv4().slice(0, 6);
    await seedRoom(roomC, [uA, uB]);
    const ca = await connect(P1, roomC, uA);
    const cb = await connect(P2, roomC, uB);
    ca.awareness.setLocalStateField("user", { name: "GhostAlice" });
    await wait(600);
    const sees = () => [...cb.awareness.getStates().values()].some((s: any) => s.user?.name === "GhostAlice");
    check(sees(), "client B on node 2 sees GhostAlice before the kill");
    // Silence A's client: no heartbeat and NO removal message. (awareness.destroy()
    // would send a graceful removal and turn this into a clean-disconnect test.)
    ca.mute();
    killProc(n1);
    n1 = null;
    const tKill = Date.now();
    console.log("   node 1 killed (hard). Polling client B for up to 40s...");
    while (Date.now() - tKill < 40000 && sees()) await wait(500);
    const gone = !sees();
    console.log(`   GhostAlice ${gone ? "disappeared" : "STILL PRESENT"} after ${((Date.now() - tKill) / 1000).toFixed(1)}s`);
    check(gone, "ghost presence expired within 40s of node death");
    cb.ws.close();
  } finally {
    killProc(n1);
    killProc(n2);
  }
  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS (Task 4 lock+merge, Task 5 node-death presence expiry)");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
