/**
 * Re-run every Week 4 / Part A proof command, keep each full log, and record the real
 * exit codes in benchmarks/results/verification.json (README "Verification" table).
 *
 *   NODE_ENV=test npx tsx tests/verify-all.ts
 *
 * Long suites recorded elsewhere are referenced, not re-run here:
 *   real-browser suite x3 -> benchmarks/results/a2-browser-suite.json (tests/playwright/run-flakiness.ts)
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const LOGS = path.join(ROOT, "benchmarks/results/logs");
fs.mkdirSync(LOGS, { recursive: true });

const TASKS: Array<{ task: string; command: string; cwd?: string; log: string }> = [
  { task: "W4 Task 0+1: room-load race, NODE_ID, /health", command: "npx tsx tests/test-task0-task1.ts", log: "w4-task0-1.log" },
  { task: "W4 Task 2+3+4+5: Redis relay, cold start, lock, presence", command: "npx tsx tests/test-multinode-sync.ts", log: "w4-task2-5.log" },
  { task: "W4 Task 4+5: lock+merge via node save path; ghost presence after node kill", command: "npx tsx tests/test-task4-5-lock-merge-presence.ts", log: "w4-task4-5.log" },
  { task: "W4 Task 6: two nodes behind the LB, failover", command: "npx tsx tests/test-task6-lb.ts", log: "w4-task6.log" },
  { task: "W4 Task 8 (protocol): websocket-protocol specs", command: "npx playwright test", cwd: "tests/sync-protocol", log: "w4-sync-protocol.log" },
  { task: "A1: own Prisma client, schema copy, migrate captures schema", command: "npx tsx tests/verify-a1.ts", log: "a1-verify.log" },
  { task: "A1: docker build of the sync service alone", command: "docker build -t codesync-sync:a1 services/sync", log: "a1-docker-build.log" },
  { task: "A3: Redis restart, client on node 2 converges <20s, no reconnect", command: "npx tsx tests/test-a3-redis-restart.ts", log: "a3-redis-restart.log" },
  { task: "A4: production build has no /e2e/editor (404)", command: "npx tsx tests/test-a4-prod-404.ts", log: "a4-prod-404.log" },
  { task: "Typecheck: sync, worker, web", command: "npx tsc -p services/sync/tsconfig.json --noEmit && npx tsc -p services/worker/tsconfig.json --noEmit && npx tsc -p apps/web/tsconfig.json --noEmit", log: "typecheck.log" },
];

const results: any[] = [];
for (const t of TASKS) {
  const t0 = Date.now();
  process.stdout.write(`- ${t.task} ... `);
  const r = spawnSync(t.command, {
    cwd: path.join(ROOT, t.cwd ?? "."),
    shell: true,
    env: { ...process.env, NODE_ENV: "test", NEXT_BUILD_CPUS: process.env.NEXT_BUILD_CPUS || "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  const out = `$ ${t.cwd ? `(cd ${t.cwd}) ` : ""}${t.command}\n\n${r.stdout ?? ""}${r.stderr ?? ""}\n[exit code ${r.status}]\n`;
  fs.writeFileSync(path.join(LOGS, t.log), out);
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`exit ${r.status} (${secs}s)`);
  results.push({ task: t.task, command: (t.cwd ? `cd ${t.cwd} && ` : "") + t.command, exit_code: r.status, seconds: secs, log: `benchmarks/results/logs/${t.log}` });
}
results.push({
  task: "A2 / W4 Task 8: real-browser suite, 3 consecutive runs",
  command: "cd tests/playwright && npx playwright test (x3)",
  exit_code: (() => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks/results/a2-browser-suite.json"), "utf8"));
      return d.summary.all_passed ? 0 : 1;
    } catch {
      return null;
    }
  })(),
  log: "benchmarks/results/a2-browser-suite.json",
});
fs.writeFileSync(
  path.join(ROOT, "benchmarks/results/verification.json"),
  JSON.stringify({ name: "verification", timestamp: new Date().toISOString(), generator: "tests/verify-all.ts", tasks: results }, null, 1)
);
console.log("wrote benchmarks/results/verification.json");
process.exit(results.every((r) => r.exit_code === 0) ? 0 : 1);
