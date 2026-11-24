// Multi-language support:
//  1. The language registries agree: web (apps/web/src/lib/languages.ts), API, worker, AI service.
//  2. Every runnable language runs through the real user path (API POST /execution -> BullMQ ->
//     worker -> hardened Docker sandbox -> Redis output stream): expected stdout + exit 0,
//     and a failing program exits non-zero with its error on stderr.
//  3. Edit-only languages: rooms can be created; Run and AI fix are refused with 400.
//
// Run: NODE_ENV=test npx tsx tests/test-languages.ts   (Docker + codesync-sandbox-* images)

process.env.NODE_ENV = "test";
process.env.EXECUTION_RATE_PER_MIN = "100";

import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import http from "http";
import { randomUUID } from "crypto";

const API_PORT = 4396;
const API = `http://127.0.0.1:${API_PORT}`;
const ROOT = path.resolve(__dirname, "..");
const TSX_CLI = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const PYTHON = path.join(ROOT, "services/ai/.venv/Scripts/python.exe");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? "\n        " + JSON.stringify(detail).slice(0, 600) : ""}`);
};
const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
  const x = [...a].sort().join(","), y = [...b].sort().join(",");
  return x === y;
};

// One program per runnable language: prints a computed value; plus a failing one.
const PROGRAMS: Record<string, { ok: string; want: string; bad: string; badErr: RegExp }> = {
  python: { ok: "def sq(n):\n    return n * n\nprint('py', sq(7))\n", want: "py 49", bad: "raise ValueError('boom')\n", badErr: /ValueError: boom/ },
  javascript: { ok: "const sq = (n) => n * n;\nconsole.log('js', sq(7));\n", want: "js 49", bad: "throw new Error('boom');\n", badErr: /Error: boom/ },
  typescript: {
    ok: "enum Color { Red, Green }\nconst sq = (n: number): number => n * n;\nconsole.log('ts', sq(7), Color.Green);\n",
    want: "ts 49 1",
    bad: "const n: number = 1;\nthrow new Error('boom ' + n);\n",
    badErr: /Error: boom 1/,
  },
  java: {
    ok: "public class Main {\n  static int sq(int n) { return n * n; }\n  public static void main(String[] a) { System.out.println(\"java \" + sq(7)); }\n}\n",
    want: "java 49",
    bad: "public class Main {\n  public static void main(String[] a) { int x = \"not an int\"; }\n}\n",
    badErr: /incompatible types|error:/,
  },
  ruby: { ok: "def sq(n) = n * n\nputs \"rb #{sq(7)}\"\n", want: "rb 49", bad: "raise ArgumentError, 'boom'\n", badErr: /boom \(ArgumentError\)/ },
  php: { ok: "<?php\nfunction sq(int $n): int { return $n * $n; }\necho 'php ', sq(7), \"\\n\";\n", want: "php 49", bad: "<?php\nthrow new Exception('boom');\n", badErr: /Exception: boom/ },
  perl: { ok: "use strict; use warnings;\nsub sq { my ($n) = @_; return $n * $n; }\nprint 'pl ', sq(7), \"\\n\";\n", want: "pl 49", bad: "die \"boom\\n\";\n", badErr: /boom/ },
  lua: { ok: "local function sq(n) return n * n end\nprint('lua ' .. sq(7))\n", want: "lua 49", bad: "error('boom')\n", badErr: /boom/ },
  bash: { ok: "sq() { echo $(( $1 * $1 )); }\necho \"sh $(sq 7)\"\n", want: "sh 49", bad: "echo boom >&2\nexit 3\n", badErr: /boom/ },
};

async function main() {
  // ── 1. Registries agree ──────────────────────────────────────────────────
  console.log("[1] registries");
  const web = await import("../apps/web/src/lib/languages");
  const apiLangs = await import("../services/api/src/lib/languages");
  const worker = await import("../services/worker/src/sandbox/languages");
  const ai = JSON.parse(
    execSync(`"${PYTHON}" -c "import json; from app.agent.languages import AI_LANGUAGES as A; print(json.dumps({k: [v[0], v[1]] for k, v in A.items()}))"`, {
      cwd: path.join(ROOT, "services/ai"),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString()
  ) as Record<string, [string, string[]]>;

  const webAll = web.LANGUAGES.map((l: any) => l.id);
  const webRun = web.RUNNABLE.map((l: any) => l.id);
  check("web ids are unique", new Set(webAll).size === webAll.length);
  check("web languages == API room languages", sameSet(webAll, apiLangs.ROOM_LANGUAGES), { webAll, api: apiLangs.ROOM_LANGUAGES });
  check("web runnable == API runnable == worker runners == AI languages",
    sameSet(webRun, apiLangs.RUNNABLE_LANGUAGES) && sameSet(webRun, Object.keys(worker.RUNNERS)) && sameSet(webRun, Object.keys(ai)),
    { webRun, api: apiLangs.RUNNABLE_LANGUAGES, worker: Object.keys(worker.RUNNERS), ai: Object.keys(ai) });
  const fileMismatch = webRun.filter((id: string) => web.languageInfo(id).file !== worker.RUNNERS[id].file || ai[id]?.[0] !== worker.RUNNERS[id].file);
  check("file names agree for every runnable language (web, worker, AI)", fileMismatch.length === 0, fileMismatch);
  const argvMismatch = webRun.filter((id: string) => JSON.stringify(ai[id]?.[1]) !== JSON.stringify(worker.RUNNERS[id].argv));
  check("AI sandbox command == worker interpreter argv (same limits flags)", argvMismatch.length === 0, argvMismatch);
  check("every runnable language has a test program here", sameSet(Object.keys(PROGRAMS), webRun), Object.keys(PROGRAMS));

  // ── Stack: API routers in-process, worker as a process ─────────────────────
  const express = (await import("express")).default;
  const { prisma } = await import("../services/api/src/lib/prisma");
  const roomsRouter = (await import("../services/api/src/routes/rooms")).default;
  const executionRouter = (await import("../services/api/src/routes/execution")).default;
  const aiRouter = (await import("../services/api/src/routes/ai")).default;
  const Redis = (await import("ioredis")).default;

  const app = express();
  app.use(express.json());
  app.use("/rooms", roomsRouter);
  app.use("/execution", executionRouter);
  app.use("/ai", aiRouter);
  const server: http.Server = await new Promise((r) => { const s = app.listen(API_PORT, () => r(s)); });

  const workerProc: ChildProcess = spawn(process.execPath, [TSX_CLI, path.join(ROOT, "services/worker/src/index.ts")], {
    cwd: path.join(ROOT, "services/worker"),
    env: { ...process.env, NODE_ENV: "test", WORKER_CONCURRENCY: "3" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerLog = "";
  workerProc.stdout!.on("data", (d) => (workerLog += d));
  workerProc.stderr!.on("data", (d) => (workerLog += d));
  const t0 = Date.now();
  while (!workerLog.includes("Execution Worker started")) {
    if (Date.now() - t0 > 60000) throw new Error("worker did not start:\n" + workerLog.slice(-2000));
    await new Promise((r) => setTimeout(r, 200));
  }

  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");
  const tag = randomUUID().slice(0, 8);
  const uid = `lang-${tag}`;
  const auth = { Authorization: `Bearer test-token-${uid}`, "Content-Type": "application/json" };
  const roomIds: string[] = [];

  /** Run code like the Run button: enqueue, subscribe, signal ready, collect until end. */
  async function run(roomId: string, language: string, code: string) {
    const res = await fetch(`${API}/execution`, { method: "POST", headers: auth, body: JSON.stringify({ roomId, code, language }) });
    if (res.status !== 200) return { status: res.status, body: await res.json(), stdout: "", stderr: "", code: null as number | null, ms: 0 };
    const { jobId } = await res.json();
    const sub = redis.duplicate();
    const out = { stdout: "", stderr: "", code: null as number | null, end: "" };
    const t = Date.now();
    await new Promise<void>(async (resolve) => {
      const timer = setTimeout(resolve, 45000);
      sub.on("message", (_ch, raw) => {
        const m = JSON.parse(raw);
        if (m.type === "stdout") out.stdout += m.data;
        if (m.type === "stderr") out.stderr += m.data;
        if (m.type === "end") { out.code = m.code; out.end = m.status; clearTimeout(timer); resolve(); }
      });
      await sub.subscribe(`room:${roomId}:execution:${jobId}`);
      await fetch(`${API}/execution/${jobId}/ready`, { method: "POST", headers: auth });
    });
    sub.disconnect();
    return { status: 200, body: null, ...out, ms: Date.now() - t };
  }

  try {
    await prisma.user.create({ data: { id: uid, email: `${uid}@test.local`, name: "Lang Tester" } });

    // ── 3a. Room creation accepts every language, rejects unknown ones ─────
    console.log("\n[3] room creation and refusals");
    let r = await fetch(`${API}/rooms`, { method: "POST", headers: auth, body: JSON.stringify({ title: "x", language: "cobol" }) });
    check("POST /rooms with an unknown language -> 400", r.status === 400, r.status);
    const goRoom = await (await fetch(`${API}/rooms`, { method: "POST", headers: auth, body: JSON.stringify({ title: "Go room", language: "go" }) })).json();
    roomIds.push(goRoom.id);
    check("edit-only language room can be created (go)", goRoom.language === "go", goRoom);
    const goRun = await run(goRoom.id, "go", "package main\nfunc main() {}\n");
    check("Run in an edit-only language -> 400 with a reason", goRun.status === 400 && /not supported/.test(goRun.body?.error), goRun);
    r = await fetch(`${API}/ai/fix`, { method: "POST", headers: auth, body: JSON.stringify({ roomId: goRoom.id, code: "package main\n", prompt: "fix", language: "go" }) });
    const goAi = await r.json();
    check("AI fix in an edit-only language -> 400 with a reason", r.status === 400 && /not available for go/.test(goAi.error), { status: r.status, goAi });

    // ── 2. Every runnable language through the real sandbox ────────────────
    console.log("\n[2] runs in the hardened sandbox (real worker + Docker)");
    for (const [lang, p] of Object.entries(PROGRAMS)) {
      const room = await (await fetch(`${API}/rooms`, { method: "POST", headers: auth, body: JSON.stringify({ title: lang, language: lang }) })).json();
      roomIds.push(room.id);
      const ok = await run(room.id, lang, p.ok);
      check(`${lang.padEnd(10)} ok program -> "${p.want}", exit 0 (${ok.ms} ms)`, ok.code === 0 && ok.stdout.trim() === p.want, ok);
      const bad = await run(room.id, lang, p.bad);
      check(`${lang.padEnd(10)} failing program -> non-zero exit, error on stderr (${bad.ms} ms)`, bad.code !== 0 && bad.code !== null && p.badErr.test(bad.stderr), bad);
    }

    // The sandbox flags apply to the new images too: no network from Ruby.
    const netRoom = roomIds[roomIds.length - 1];
    const net = await run(netRoom, "ruby", "require 'socket'\nbegin\n  TCPSocket.new('1.1.1.1', 80)\n  puts 'NETWORK OPEN'\nrescue => e\n  puts \"blocked: #{e.class}\"\nend\n");
    check("network is blocked in a new image (ruby)", net.code === 0 && /blocked:/.test(net.stdout) && !/NETWORK OPEN/.test(net.stdout), net);
  } finally {
    await redis.quit();
    if (workerProc.pid) {
      try { process.platform === "win32" ? execSync(`taskkill /pid ${workerProc.pid} /T /F`, { stdio: "ignore" }) : workerProc.kill("SIGKILL"); } catch {}
    }
    server.close();
    await prisma.executionLog.deleteMany({ where: { userId: uid } });
    await prisma.projectFile.deleteMany({ where: { roomId: { in: roomIds } } });
    await prisma.roomMember.deleteMany({ where: { roomId: { in: roomIds } } });
    await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    await prisma.user.deleteMany({ where: { id: uid } });
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
