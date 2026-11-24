// Part 1 (docs/PLAN-remaining.md): backend support for the UI.
//   1.1 GET /rooms          — caller's rooms only, 401 without auth
//   1.2 AI progress (SSE)   — every step in order then done; mixed mock scenario => a retry
//   1.3 GET /rooms/:id      — member list with roles, viewer sees own role, no passcodeHash
// Also covers the shared `authenticate` middleware now used by /rooms, /ai and /execution.
//
// Real: Postgres, Redis, API routers (Express), AI service (uvicorn, LangGraph, LLM_PROVIDER=mock_scenario).
// Stub: the sandbox endpoint (SANDBOX_URL) — passes iff main.py has the correct body. The hardened
// sandbox path is covered by its own suites; this test is about the progress stream.
//
// Run: NODE_ENV=test npx tsx tests/test-part1-backend.ts

process.env.NODE_ENV = "test";
process.env.SYNC_SERVICE_URL = "http://127.0.0.1:1"; // no sync node: /ai/fix falls back to "latest"

import { spawn, ChildProcess, execSync } from "child_process";
import express from "express";
import http from "http";
import path from "path";
import { randomUUID } from "crypto";
import { prisma } from "../services/api/src/lib/prisma";
import roomsRouter from "../services/api/src/routes/rooms";
import aiRouter from "../services/api/src/routes/ai";
import executionRouter from "../services/api/src/routes/execution";
import { closeProgressClients } from "../services/api/src/lib/aiProgress";

const API_PORT = 4296;
const AI_PORT = 4297;
const SANDBOX_STUB_PORT = 4298;
const DEAD_PORT = 4299;
const API = `http://127.0.0.1:${API_PORT}`;
const PYTHON_EXE = path.resolve(__dirname, "../services/ai/.venv/Scripts/python.exe");
const AI_DIR = path.resolve(__dirname, "../services/ai");
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6380";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `\n        ${JSON.stringify(detail)}` : ""}`);
  }
}

const auth = (uid: string) => ({ Authorization: `Bearer test-token-${uid}` });
const jsonAuth = (uid: string) => ({ ...auth(uid), "Content-Type": "application/json" });

function killProc(proc: ChildProcess | null) {
  if (!proc?.pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    else proc.kill("SIGKILL");
  } catch {}
}

type SseResult = { status: number; events: any[]; sawReady: boolean; ended: boolean; body?: string };

/** Open the progress stream with fetch (EventSource cannot send Authorization). */
function openProgress(progressId: string, roomId: string, uid?: string) {
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const done = (async (): Promise<SseResult> => {
    const res = await fetch(`${API}/ai/progress/${progressId}?roomId=${encodeURIComponent(roomId)}`, {
      headers: uid ? auth(uid) : {},
    });
    if (res.status !== 200) {
      resolveReady();
      return { status: res.status, events: [], sawReady: false, ended: true, body: await res.text() };
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const events: any[] = [];
    let sawReady = false;
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (type === "ready") {
          sawReady = true;
          resolveReady();
        } else if (type === "progress" && data) {
          events.push(JSON.parse(data));
        }
      }
    }
    resolveReady();
    return { status: 200, events, sawReady, ended: true };
  })();
  return { ready, done };
}

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);

async function waitForHttp(url: string, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`not up after ${ms}ms: ${url}`);
}

async function main() {
  const tag = randomUUID().slice(0, 8);
  const owner = `p1-owner-${tag}`;
  const editor = `p1-editor-${tag}`;
  const viewer = `p1-viewer-${tag}`;
  const outsider = `p1-out-${tag}`;
  let apiServer: http.Server | null = null;
  let stubServer: http.Server | null = null;
  let aiProc: ChildProcess | null = null;
  const roomIds: string[] = [];

  try {
    // ── Setup ─────────────────────────────────────────────────────────────
    const stub = express();
    stub.use(express.json({ limit: "2mb" }));
    let sandboxCalls = 0;
    stub.post("/sandbox", (req, res) => {
      sandboxCalls++;
      const src: string = req.body?.files?.["main.py"] ?? "";
      if (src.includes("return a + b")) return res.json({ status: "passed", exitCode: 0, stdout: "ok\n", stderr: "" });
      return res.json({ status: "failed", exitCode: 1, stdout: "", stderr: "AssertionError: add_one(1, 2) != 3" });
    });
    stubServer = await new Promise((r) => { const s = stub.listen(SANDBOX_STUB_PORT, () => r(s)); });

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/rooms", roomsRouter);
    app.use("/ai", aiRouter);
    app.use("/execution", executionRouter);
    apiServer = await new Promise((r) => { const s = app.listen(API_PORT, () => r(s)); });

    aiProc = spawn(PYTHON_EXE, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(AI_PORT)], {
      cwd: AI_DIR,
      env: {
        ...process.env,
        LLM_PROVIDER: "mock_scenario",
        SANDBOX_URL: `http://127.0.0.1:${SANDBOX_STUB_PORT}/sandbox`,
        REDIS_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let aiLog = "";
    aiProc.stdout!.on("data", (d) => (aiLog += d));
    aiProc.stderr!.on("data", (d) => (aiLog += d));
    const tAi = Date.now();
    await waitForHttp(`http://127.0.0.1:${AI_PORT}/health`, 60000).catch((e) => {
      console.log(aiLog.slice(-3000));
      throw e;
    });
    console.log(`[setup] AI service up in ${Date.now() - tAi}ms`);
    process.env.AI_SERVICE_URL = `http://127.0.0.1:${AI_PORT}`;

    await prisma.user.createMany({
      data: [owner, editor, viewer, outsider].map((id) => ({ id, email: `${id}@test.local`, name: id.split("-")[1] })),
    });

    // ── 1.1 / auth ───────────────────────────────────────────────────────
    console.log("\n[1.1] GET /rooms and auth");
    let r = await fetch(`${API}/rooms`);
    check("GET /rooms without auth -> 401 JSON", r.status === 401 && (await r.json()).error === "Unauthorized", r.status);
    r = await fetch(`${API}/rooms`, { headers: auth(`nobody-${tag}`) });
    check("GET /rooms with unknown test user -> 401", r.status === 401, r.status);
    r = await fetch(`${API}/execution`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    check("POST /execution without auth -> 401 (was a 302 redirect before)", r.status === 401, r.status);
    r = await fetch(`${API}/ai/fix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    check("POST /ai/fix without auth -> 401", r.status === 401, r.status);

    r = await fetch(`${API}/rooms`, { method: "POST", headers: jsonAuth(owner), body: JSON.stringify({ title: "Py room", language: "cobol" }) });
    check("POST /rooms with unsupported language -> 400", r.status === 400, r.status);

    r = await fetch(`${API}/rooms`, {
      method: "POST",
      headers: jsonAuth(owner),
      body: JSON.stringify({ title: "Py room", language: "python", isPrivate: false, passcode: "s3cret" }),
    });
    const created = await r.json();
    roomIds.push(created.id);
    check(
      "POST /rooms stores language/isPrivate, returns no passcodeHash",
      r.status === 200 && created.language === "python" && created.isPrivate === false &&
        created.hasPasscode === true && !("passcodeHash" in created) && created.myRole === "OWNER",
      created
    );

    r = await fetch(`${API}/rooms`, { method: "POST", headers: jsonAuth(owner), body: JSON.stringify({ title: "JS room" }) });
    const roomJs = await r.json();
    roomIds.push(roomJs.id);
    check("POST /rooms defaults: javascript, private", roomJs.language === "javascript" && roomJs.isPrivate === true, roomJs);

    r = await fetch(`${API}/rooms`, { method: "POST", headers: jsonAuth(editor), body: JSON.stringify({ title: "Editor's own" }) });
    const roomEd = await r.json();
    roomIds.push(roomEd.id);

    r = await fetch(`${API}/rooms/${created.id}/join`, { method: "POST", headers: jsonAuth(editor), body: JSON.stringify({ passcode: "wrong" }) });
    check("join with wrong passcode -> 401", r.status === 401, r.status);
    r = await fetch(`${API}/rooms/${created.id}/join`, { method: "POST", headers: jsonAuth(editor), body: JSON.stringify({ passcode: "s3cret" }) });
    check("join with passcode -> EDITOR member", r.status === 200 && (await r.json()).role === "EDITOR", r.status);
    await prisma.roomMember.create({ data: { roomId: created.id, userId: viewer, role: "VIEWER" } });

    // Make the JS room the most recently updated one.
    await prisma.projectFile.create({ data: { roomId: roomJs.id, path: "main.js", language: "javascript" } });

    r = await fetch(`${API}/rooms`, { headers: auth(owner) });
    const ownerList = (await r.json()).rooms;
    check(
      "owner sees exactly their 2 rooms, newest-updated first",
      r.status === 200 && ownerList.length === 2 && ownerList[0].id === roomJs.id && ownerList[1].id === created.id,
      ownerList.map((x: any) => [x.id, x.lastUpdatedAt])
    );
    const pyEntry = ownerList.find((x: any) => x.id === created.id);
    check(
      "list entry has title, language, role, lastUpdatedAt, memberCount; no passcodeHash",
      pyEntry && pyEntry.title === "Py room" && pyEntry.language === "python" && pyEntry.role === "OWNER" &&
        typeof pyEntry.lastUpdatedAt === "string" && pyEntry.memberCount === 3 && !("passcodeHash" in pyEntry),
      pyEntry
    );
    r = await fetch(`${API}/rooms`, { headers: auth(editor) });
    const edList = (await r.json()).rooms;
    check(
      "editor sees own room + joined room with role EDITOR, not owner's JS room",
      edList.length === 2 && edList.some((x: any) => x.id === created.id && x.role === "EDITOR") &&
        edList.some((x: any) => x.id === roomEd.id && x.role === "OWNER") && !edList.some((x: any) => x.id === roomJs.id),
      edList.map((x: any) => [x.id, x.role])
    );
    r = await fetch(`${API}/rooms`, { headers: auth(outsider) });
    check("outsider sees no rooms", (await r.json()).rooms.length === 0);

    // ── 1.3 ──────────────────────────────────────────────────────────────
    console.log("\n[1.3] GET /rooms/:id members and roles");
    r = await fetch(`${API}/rooms/${created.id}`, { headers: auth(viewer) });
    const view = await r.json();
    const roles = Object.fromEntries((view.members ?? []).map((m: any) => [m.userId, m.role]));
    check("viewer sees own role VIEWER", r.status === 200 && view.myRole === "VIEWER", view.myRole);
    check(
      "member list has all 3 with roles and names",
      roles[owner] === "OWNER" && roles[editor] === "EDITOR" && roles[viewer] === "VIEWER" &&
        view.members.every((m: any) => typeof m.name === "string"),
      view.members
    );
    check(
      "room view leaks neither passcodeHash nor member emails",
      !JSON.stringify(view).includes("passcodeHash") && !JSON.stringify(view).includes("@test.local"),
      Object.keys(view)
    );
    r = await fetch(`${API}/rooms/${created.id}`, { headers: auth(outsider) });
    check("outsider GET /rooms/:id -> 403", r.status === 403, r.status);
    r = await fetch(`${API}/rooms/${created.id}`);
    check("GET /rooms/:id without auth -> 401", r.status === 401, r.status);

    // ── 1.2 ──────────────────────────────────────────────────────────────
    console.log("\n[1.2] AI progress streaming");
    const buggy = "def add_one(a, b):\n    return a - b\n";
    const fixBody = (trial: string, progressId?: string) =>
      JSON.stringify({
        roomId: created.id,
        code: buggy,
        prompt: `add_one should add [[b6:mixed:add_one:${trial}]]`,
        language: "python",
        filePath: "main.py",
        testCommand: ["python3", "main.py"],
        ...(progressId ? { progressId } : {}),
      });

    const pid = randomUUID();
    r = await fetch(`${API}/ai/progress/not-a-uuid?roomId=${created.id}`, { headers: auth(owner) });
    check("progress with non-UUID id -> 400", r.status === 400, r.status);
    r = await fetch(`${API}/ai/progress/${pid}?roomId=${created.id}`);
    check("progress without auth -> 401", r.status === 401, r.status);
    r = await fetch(`${API}/ai/progress/${pid}?roomId=${created.id}`, { headers: auth(outsider) });
    check("progress by non-member -> 403", r.status === 403, r.status);

    const sub = openProgress(pid, created.id, owner);
    await withTimeout(sub.ready, 10000, "SSE ready");
    const t0 = Date.now();
    r = await fetch(`${API}/ai/fix`, { method: "POST", headers: jsonAuth(owner), body: fixBody(`t${tag}a`, pid) });
    const fix = await r.json();
    const fixMs = Date.now() - t0;
    const stream = await withTimeout(sub.done, 30000, "SSE end");
    const steps = stream.events.map((e) => (e.attempt ? `${e.step}:${e.attempt}` : e.step));
    console.log(`        fix ${fixMs}ms, status=${fix.status}, llm_calls=${fix.llm_calls}, sandbox calls=${sandboxCalls}`);
    console.log(`        events: ${steps.join(" -> ")}`);

    check("POST /ai/fix with progressId -> 200 verified", r.status === 200 && fix.status === "verified", fix);
    check(
      "/ai/fix response shape unchanged (same keys + interactionId)",
      ["patch", "status", "function_name", "start_line", "end_line", "patched_text", "original_code", "new_code",
        "error_message", "llm_calls", "total_cost_usd", "interactionId"].every((k) => k in fix),
      Object.keys(fix)
    );
    check("subscriber got 'ready' before the request", stream.sawReady);
    check(
      "every step in order: context, generating:1, retrying:2, generating:2, applying:2, testing:2, done",
      JSON.stringify(steps) ===
        JSON.stringify(["context", "generating:1", "retrying:2", "generating:2", "applying:2", "testing:2", "done"]),
      steps
    );
    check("seq is 1..n with no gaps", stream.events.every((e, i) => e.seq === i + 1), stream.events.map((e) => e.seq));
    const retryEv = stream.events.find((e) => e.step === "retrying");
    check("retry event names the reason (malformed LLM output)", retryEv?.retry === 1 && retryEv?.reason === "llm_parse_error", retryEv);
    const doneEv = stream.events[stream.events.length - 1];
    check("done event carries status and llm_calls=2", doneEv?.status === "verified" && doneEv?.llm_calls === 2, doneEv);
    check("stream closed by the server after done", stream.ended);

    const late = await withTimeout(openProgress(pid, created.id, owner).done, 10000, "late SSE");
    check(
      "late subscriber gets the same events replayed, then the stream ends",
      JSON.stringify(late.events.map((e) => e.seq)) === JSON.stringify(stream.events.map((e) => e.seq)),
      late.events.map((e) => e.step)
    );

    r = await fetch(`${API}/ai/progress/${pid}?roomId=${created.id}`, { headers: auth(viewer) });
    check("another member cannot read someone else's progressId -> 403", r.status === 403, r.status);
    r = await fetch(`${API}/ai/fix`, { method: "POST", headers: jsonAuth(editor), body: fixBody(`t${tag}b`, pid) });
    check("reusing a progressId bound to another user -> 409", r.status === 409, r.status);
    r = await fetch(`${API}/ai/fix`, { method: "POST", headers: jsonAuth(owner), body: fixBody(`t${tag}c`, "nope") });
    check("POST /ai/fix with non-UUID progressId -> 400", r.status === 400, r.status);

    r = await fetch(`${API}/ai/fix`, { method: "POST", headers: jsonAuth(owner), body: fixBody(`t${tag}d`) });
    const noPid = await r.json();
    check("POST /ai/fix without progressId still works", r.status === 200 && noPid.status === "verified", noPid.status);

    // AI service unreachable: the API publishes `failed` so the subscriber does not hang.
    const pid2 = randomUUID();
    const sub2 = openProgress(pid2, created.id, owner);
    await withTimeout(sub2.ready, 10000, "SSE2 ready");
    process.env.AI_SERVICE_URL = `http://127.0.0.1:${DEAD_PORT}`;
    r = await fetch(`${API}/ai/fix`, { method: "POST", headers: jsonAuth(owner), body: fixBody(`t${tag}e`, pid2) });
    process.env.AI_SERVICE_URL = `http://127.0.0.1:${AI_PORT}`;
    const s2 = await withTimeout(sub2.done, 10000, "SSE2 end");
    check(
      "AI service down: /ai/fix 500 and stream ends with a single failed event",
      r.status === 500 && s2.events.length === 1 && s2.events[0].step === "failed",
      { status: r.status, events: s2.events }
    );

    // ── Room settings + delete (owner only) ───────────────────────────────
    console.log("\n[rooms] settings and delete");
    const patch = (uid: string, body: unknown) =>
      fetch(`${API}/rooms/${created.id}`, { method: "PATCH", headers: jsonAuth(uid), body: JSON.stringify(body) });
    r = await patch(editor, { title: "Hijacked" });
    check("editor cannot change room settings -> 403", r.status === 403, r.status);
    r = await patch(owner, { language: "cobol" });
    check("unknown language in settings -> 400", r.status === 400, r.status);
    r = await patch(owner, { title: "  Renamed room  ", language: "ruby", passcode: null, isPrivate: true });
    const renamed = await r.json();
    check(
      "owner renames, switches language, removes passcode",
      r.status === 200 && renamed.title === "Renamed room" && renamed.language === "ruby" && renamed.hasPasscode === false && renamed.isPrivate === true,
      renamed
    );
    r = await fetch(`${API}/rooms/${created.id}/join`, { method: "POST", headers: jsonAuth(outsider), body: "{}" });
    check("after removing the passcode anyone with the ID can join", r.status === 200, r.status);
    r = await fetch(`${API}/rooms/${created.id}`, { method: "DELETE", headers: auth(editor) });
    check("editor cannot delete the room -> 403", r.status === 403, r.status);
    r = await fetch(`${API}/rooms/${created.id}`, { method: "DELETE", headers: auth(owner) });
    check("owner deletes the room -> 200", r.status === 200, r.status);
    const left = await Promise.all([
      prisma.room.count({ where: { id: created.id } }),
      prisma.roomMember.count({ where: { roomId: created.id } }),
      prisma.aIInteraction.count({ where: { roomId: created.id } }),
    ]);
    check("room, members and AI history are gone", left.every((n) => n === 0), left);
    r = await fetch(`${API}/rooms`, { headers: auth(owner) });
    check("deleted room no longer listed", !(await r.json()).rooms.some((x: any) => x.id === created.id));
  } finally {
    killProc(aiProc);
    await new Promise((r) => (apiServer ? apiServer.close(() => r(null)) : r(null)));
    await new Promise((r) => (stubServer ? stubServer.close(() => r(null)) : r(null)));
    const users = [owner, editor, viewer, outsider];
    await prisma.aIInteraction.deleteMany({ where: { userId: { in: users } } });
    await prisma.projectFile.deleteMany({ where: { roomId: { in: roomIds } } });
    await prisma.roomMember.deleteMany({ where: { OR: [{ userId: { in: users } }, { roomId: { in: roomIds } }] } });
    await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await closeProgressClients();
    await prisma.$disconnect();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
