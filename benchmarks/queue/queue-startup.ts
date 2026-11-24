/**
 * Phase 6 B2 — queue delay and sandbox startup.
 *
 *   NODE_ENV=test npx tsx benchmarks/queue/queue-startup.ts [--quick]
 *
 * Starts the real API (:4150, NODE_ENV=test) and the real worker (WORKER_CONCURRENCY =
 * 1, 4, 8 in turn). For each concurrency, N = 1, 10, 50, 100 simultaneous POST
 * /execution submissions (Promise.all), each from a DIFFERENT test user so the per-user
 * 10/min execution limit does not hide results (429s are still counted). After each
 * submission the client immediately POSTs /execution/:jobId/ready, exactly as the
 * terminal does, so the worker's 5 s ready-wait is not part of the numbers.
 * MAX_QUEUE_LENGTH is left at its default (50): 503s are counted, not tuned away.
 *
 * Per job (worker timing hash execution:timing:<jobId>):
 *   queue_wait_ms                 pickedAt - enqueuedAt   (BullMQ timestamps)
 *   enqueue_to_container_start_ms dockerSpawnAt - enqueuedAt
 *   enqueue_to_first_output_ms    firstOutputAt - enqueuedAt
 * Cold start (separate): language node / python, 10 sequential jobs each at
 * concurrency 1: container_start_to_first_output_ms = firstOutputAt - dockerSpawnAt.
 * Program: print one line (console.log / print). Same hardened docker flags as always.
 */
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { prisma } from "../../services/api/src/lib/prisma";
import { killProc } from "../../tests/playwright/helpers";
import { stats, writeResult, RunRecord, sleep, ROOT } from "../lib/bench";

const QUICK = process.argv.includes("--quick");
// B7: `--warm-pool N` runs ONLY the cold-start measurement, with the worker's warm pool
// enabled (SANDBOX_WARM_POOL_SIZE=N), and writes b7-coldstart-<lang>-warm.json.
const warmArg = process.argv.indexOf("--warm-pool");
const WARM_POOL = warmArg > 0 ? Number(process.argv[warmArg + 1]) : 0;
const API_PORT = 4150;
const API = `http://127.0.0.1:${API_PORT}`;
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const CONCURRENCIES = WARM_POOL ? [1] : QUICK ? [4] : [1, 4, 8];
const SIZES = WARM_POOL ? [] : QUICK ? [1, 10] : [1, 10, 50, 100];
const RUNS = QUICK ? 1 : 3;
const ROOM = "b2-bench-room";
const USERS = Array.from({ length: 300 }, (_, i) => `b2-user-${i}`);
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");
const queue = new Queue("code_execution", { connection: new Redis(process.env.REDIS_URL || "redis://localhost:6380", { maxRetriesPerRequest: null }) });
let userPtr = 0;

/**
 * Guard: the measured worker must be the ONLY consumer of the queue. (A stray worker
 * left from manual debugging once consumed jobs during a B2 run and made every
 * "WORKER_CONCURRENCY=c" row really c+1; those results were discarded.)
 */
async function assertWorkers(expected: number, label: string) {
  for (let i = 0; i < 40; i++) {
    const n = await queue.getWorkersCount();
    if (n === expected) return n;
    if (n > expected) throw new Error(`${label}: ${n} BullMQ workers attached to code_execution, expected ${expected}. Stop the other worker(s) first.`);
    await sleep(500);
  }
  throw new Error(`${label}: worker count never reached ${expected}`);
}
const nextUser = () => USERS[userPtr++ % USERS.length];

async function seed() {
  await prisma.user.createMany({ data: USERS.map((id) => ({ id, email: `${id}@bench.local`, name: id })), skipDuplicates: true });
  const room = await prisma.room.findUnique({ where: { id: ROOM } });
  if (!room) await prisma.room.create({ data: { id: ROOM, title: ROOM, ownerId: USERS[0] } });
  await prisma.roomMember.createMany({
    data: USERS.map((u, i) => ({ roomId: ROOM, userId: u, role: i === 0 ? ("OWNER" as const) : ("EDITOR" as const) })),
    skipDuplicates: true,
  });
}

const LOG_DIR = path.join(ROOT, "benchmarks/results/logs");

function startProc(file: string, cwd: string, env: Record<string, string>, readyRe: RegExp, logName: string): Promise<ChildProcess> {
  return new Promise((resolve) => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const log = fs.createWriteStream(path.join(LOG_DIR, logName));
    const p = spawn(process.execPath, [TSX, file], { cwd, env: { ...process.env, NODE_ENV: "test", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout?.pipe(log);
    p.stderr?.pipe(log);
    let done = false;
    const onData = (d: Buffer) => {
      if (!done && readyRe.test(d.toString())) {
        done = true;
        resolve(p);
      }
    };
    p.stdout?.on("data", onData);
    p.stderr?.on("data", onData);
    setTimeout(() => !done && resolve(p), 15000);
  });
}

async function waitQueueEmpty(timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [w, a, d] = await Promise.all([
      redis.llen("bull:code_execution:wait"),
      redis.llen("bull:code_execution:active"),
      redis.zcard("bull:code_execution:delayed"),
    ]);
    if (w + a + d === 0) return;
    await sleep(250);
  }
  throw new Error("queue did not drain");
}

interface JobOutcome {
  http: number;
  jobId?: string;
  timing?: Record<string, string>;
}

async function submit(language: "javascript" | "python"): Promise<JobOutcome> {
  const user = nextUser();
  const code = language === "python" ? 'print("b2")\n' : 'console.log("b2");\n';
  const res = await fetch(`${API}/execution`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer test-token-${user}` },
    body: JSON.stringify({ roomId: ROOM, code, language }),
  });
  if (res.status !== 200) return { http: res.status };
  const { jobId } = (await res.json()) as { jobId: string };
  await fetch(`${API}/execution/${jobId}/ready`, { method: "POST", headers: { Authorization: `Bearer test-token-${user}` } });
  return { http: 200, jobId };
}

async function collectTimings(outcomes: JobOutcome[], timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  for (const o of outcomes) {
    if (!o.jobId) continue;
    while (Date.now() < deadline) {
      // The worker writes this hash once, in runInDocker's finally block, so its
      // existence means the job attempt has finished (successfully or not).
      const t = await redis.hgetall(`execution:timing:${o.jobId}`);
      if (Object.keys(t).length > 0) {
        o.timing = t;
        break;
      }
      await sleep(100);
    }
  }
}

const num = (t: Record<string, string> | undefined, k: string) => (t && t[k] !== undefined ? Number(t[k]) : NaN);

async function batch(n: number, run: number, warmup: boolean): Promise<RunRecord> {
  await waitQueueEmpty();
  const outcomes = await Promise.all(Array.from({ length: n }, () => submit("javascript")));
  await collectTimings(outcomes);
  const ok = outcomes.filter((o) => o.timing);
  const qWait = ok.map((o) => num(o.timing, "pickedAt") - num(o.timing, "enqueuedAt")).filter(Number.isFinite);
  const toStart = ok.map((o) => num(o.timing, "dockerSpawnAt") - num(o.timing, "enqueuedAt")).filter(Number.isFinite);
  const toOut = ok.map((o) => num(o.timing, "firstOutputAt") - num(o.timing, "enqueuedAt")).filter(Number.isFinite);
  const codes: Record<string, number> = {};
  outcomes.forEach((o) => (codes[o.http] = (codes[o.http] ?? 0) + 1));
  const readyTimeouts = ok.filter((o) => o.timing?.readySignal === "timeout").length;
  // Final BullMQ state of every accepted job (failed/stalled jobs must show, not vanish).
  const jobStates: Record<string, number> = {};
  for (const o of outcomes) {
    if (!o.jobId) continue;
    const j = await queue.getJob(o.jobId);
    const st = j ? await j.getState() : "missing";
    jobStates[st] = (jobStates[st] ?? 0) + 1;
  }
  const rec: RunRecord = {
    run,
    warmup,
    samples_ms: toStart,
    stats: stats(toStart),
    extra: {
      submitted: n,
      http_status_counts: codes,
      http_429: codes["429"] ?? 0,
      http_503: codes["503"] ?? 0,
      jobs_with_timing: ok.length,
      jobs_without_container_start: ok.filter((o) => !o.timing?.dockerSpawnAt).length,
      jobs_never_finished: outcomes.filter((o) => o.jobId && !o.timing).length,
      ready_signal_timeouts: readyTimeouts,
      bullmq_job_states: jobStates,
      queue_wait_ms: { samples: qWait, stats: stats(qWait) },
      enqueue_to_first_output_ms: { samples: toOut, stats: stats(toOut) },
    },
  };
  console.log(
    `    N=${n} ${warmup ? "warm-up" : "run " + run}: http=${JSON.stringify(codes)} timed=${ok.length} ` +
      `enqueue->container p50=${rec.stats.p50} p95=${rec.stats.p95} p99=${rec.stats.p99} ms; queue wait p95=${stats(qWait).p95}; states=${JSON.stringify(jobStates)} readyTimeouts=${readyTimeouts}`
  );
  return rec;
}

async function coldStart(language: "javascript" | "python", count: number, run: number, warmup: boolean): Promise<RunRecord> {
  const samples: number[] = [];
  const total: number[] = [];
  const paths: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    await waitQueueEmpty();
    const o = await submit(language);
    await collectTimings([o]);
    const s = num(o.timing, "firstOutputAt") - num(o.timing, "dockerSpawnAt");
    const e = num(o.timing, "exitAt") - num(o.timing, "dockerSpawnAt");
    const sb = o.timing?.sandbox ?? "fresh";
    paths[sb] = (paths[sb] ?? 0) + 1;
    // A warm-pool run must only count jobs that really used a warm container.
    if (WARM_POOL && sb !== "warm") continue;
    if (Number.isFinite(s)) samples.push(s);
    if (Number.isFinite(e)) total.push(e);
  }
  const rec: RunRecord = {
    run,
    warmup,
    samples_ms: samples,
    stats: stats(samples),
    extra: { docker_run_spawn_to_exit_ms: { samples: total, stats: stats(total) }, sandbox_path_counts: paths },
  };
  console.log(`    ${language} ${warmup ? "warm-up" : "run " + run}: spawn->first output p50=${rec.stats.p50} p95=${rec.stats.p95} ms; spawn->exit p50=${stats(total).p50}`);
  return rec;
}

async function main() {
  await seed();
  // Clear rate-limit windows left by earlier runs for our users.
  const keys = await redis.keys("ratelimit:b2-user-*");
  if (keys.length) await redis.del(...keys);

  await assertWorkers(0, "before start");
  const api = await startProc(path.join(ROOT, "services/api/src/index.ts"), path.join(ROOT, "services/api"), { API_PORT: String(API_PORT) }, /API listening/, "b2-api.log");
  const files: string[] = [];
  try {
    for (const c of CONCURRENCIES) {
      console.log(`\n[B2] WORKER_CONCURRENCY=${c}`);
      const worker = await startProc(path.join(ROOT, "services/worker/src/index.ts"), path.join(ROOT, "services/worker"), { WORKER_CONCURRENCY: String(c), SANDBOX_WARM_POOL_SIZE: String(WARM_POOL) }, /Worker started/, `${WARM_POOL ? "b7" : "b2"}-worker-c${c}.log`);
      if (WARM_POOL) await sleep(8000); // let the pool fill before measuring
      await sleep(3000);
      await assertWorkers(1, `WORKER_CONCURRENCY=${c}`);
      console.log(`  BullMQ workers attached to code_execution: 1 (verified)`);
      try {
        for (const n of SIZES) {
          const runs: RunRecord[] = [await batch(n, 0, true)];
          for (let r = 1; r <= RUNS; r++) runs.push(await batch(n, r, false));
          files.push(
            writeResult(`b2-queue-c${c}-n${n}`, {
              title: `Enqueue to container start: ${n} concurrent submissions, WORKER_CONCURRENCY=${c}`,
              sourceDirs: ["services/api/src", "services/worker/src", "benchmarks/queue", "benchmarks/lib"],
              conditions: {
                worker_concurrency: c,
                concurrent_submissions: n,
                submission: "Promise.all of POST /execution, each from a different test user, then POST /execution/:jobId/ready",
                program: 'javascript: console.log("b2") in codesync-sandbox-node',
                max_queue_length: Number(process.env.MAX_QUEUE_LENGTH || 50),
                rate_limit: "EXECUTION_RATE_PER_MIN default (10/min per user); users rotate over 300 test users",
                sandbox_flags: "unchanged: --network none --read-only --cap-drop ALL --pids-limit 64 --memory 256m --cpus 0.5 ...",
                docker: "Docker Desktop on Windows (WSL2 VM): every docker run goes CLI -> named pipe -> VM",
                bullmq_workers_on_queue: 1,
                samples_ms_is: "enqueue_to_container_start_ms = docker run spawned - BullMQ job.timestamp, accepted jobs only",
              },
              protocol: `1 warm-up batch + ${RUNS} measured batches; queue drained before each batch`,
              runs,
            })
          );
        }
        if (c === 1) {
          for (const lang of ["javascript", "python"] as const) {
            console.log(`  [B2] cold start ${lang}`);
            const runs: RunRecord[] = [await coldStart(lang, 3, 0, true)];
            for (let r = 1; r <= RUNS; r++) runs.push(await coldStart(lang, QUICK ? 3 : 10, r, false));
            files.push(
              writeResult(`${WARM_POOL ? "b7" : "b2"}-coldstart-${lang === "javascript" ? "node" : "python"}${WARM_POOL ? "-warm" : ""}`, {
                title: WARM_POOL
                  ? `Sandbox startup with warm pool (${lang === "javascript" ? "node" : "python"}): container claimed -> first output`
                  : `Sandbox cold start (${lang === "javascript" ? "node" : "python"}): docker run spawned -> first output`,
                sourceDirs: ["services/worker/src", "benchmarks/queue", "benchmarks/lib", "infra/docker/sandbox-images"],
                conditions: {
                  language: lang,
                  image: lang === "python" ? "codesync-sandbox-python" : "codesync-sandbox-node",
                  program: lang === "python" ? 'print("b2")' : 'console.log("b2")',
                  worker_concurrency: 1,
                  jobs: "sequential, one at a time, queue empty",
                  docker: "Docker Desktop on Windows (WSL2 VM); a fresh --rm container per job (never reused)",
                  samples_ms_is: WARM_POOL
                    ? "firstOutputAt - dockerSpawnAt, where dockerSpawnAt = warm container claimed (program then piped over stdin); container boot happened before the job"
                    : "firstOutputAt - dockerSpawnAt (container create + start + runtime boot + first print)",
                  warm_pool_size_per_language: WARM_POOL,
                },
                protocol: `1 warm-up run (3 jobs) + ${RUNS} measured runs (${QUICK ? 3 : 10} jobs each)`,
                runs,
              })
            );
          }
        }
      } finally {
        killProc(worker);
        await assertWorkers(0, `after WORKER_CONCURRENCY=${c}`);
      }
    }
  } finally {
    killProc(api);
    await redis.quit();
    await queue.close();
    await prisma.$disconnect();
  }
  console.log("\nwrote:\n  " + files.join("\n  "));
  process.exit(0);
}

main().catch((e) => {
  console.error("B2 FAILED:", e);
  process.exit(1);
});
