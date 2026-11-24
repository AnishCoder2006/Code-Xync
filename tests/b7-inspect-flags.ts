/**
 * B7: are the warm-pool containers hardened exactly like fresh job containers?
 *
 *   npx tsx tests/b7-inspect-flags.ts
 *
 * 1. Fresh path: a real job through runInDocker (python program that sleeps 3 s) — while
 *    it runs, `docker inspect codesync-job-<id>`.
 * 2. Warm path: a WarmPool container sitting READY in the pool — `docker inspect` it.
 * 3. Compare every hardening field with each other AND with limits.ts.
 * Writes benchmarks/results/b7-hardening-inspect.json; exit 1 on any hardening mismatch.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import Redis from "ioredis";
import { runInDocker } from "../services/worker/src/sandbox/dockerRunner";
import { WarmPool } from "../services/worker/src/sandbox/warmPool";
import { SANDBOX_LIMITS } from "../services/worker/src/sandbox/limits";

const ROOT = path.resolve(__dirname, "..");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inspect = (name: string) => JSON.parse(execFileSync("docker", ["inspect", name]).toString())[0];

function hardening(i: any) {
  const h = i.HostConfig;
  return {
    NetworkMode: h.NetworkMode,
    ReadonlyRootfs: h.ReadonlyRootfs,
    Tmpfs: h.Tmpfs,
    CapDrop: h.CapDrop,
    CapAdd: h.CapAdd,
    SecurityOpt: h.SecurityOpt,
    Memory: h.Memory,
    MemorySwap: h.MemorySwap,
    NanoCpus: h.NanoCpus,
    PidsLimit: h.PidsLimit,
    Privileged: h.Privileged,
    User: i.Config.User,
    AutoRemove: h.AutoRemove,
  };
}

async function main() {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");
  const jobId = `b7-inspect-${Date.now()}`;
  const fresh = runInDocker(jobId, "b7-inspect", "import time\nprint('fresh up', flush=True)\ntime.sleep(3)\n", "python", redis, {
    isSnapshot: true,
    files: { "main.py": "import time\nprint('fresh up', flush=True)\ntime.sleep(3)\n" },
    command: ["python3", "main.py"],
  });
  let freshInspect: any = null;
  for (let i = 0; i < 60 && !freshInspect; i++) {
    try {
      freshInspect = inspect(`codesync-job-${jobId}`);
    } catch {
      await wait(100);
    }
  }
  const pool = new WarmPool(1);
  pool.start();
  for (let i = 0; i < 200 && pool.readyCount("python") === 0; i++) await wait(100);
  const warm = pool.claim("python");
  if (!freshInspect || !warm) throw new Error(`could not inspect: fresh=${!!freshInspect} warm=${!!warm}`);
  const warmInspect = inspect(warm.name);
  await fresh;
  warm.child.stdin?.end("print('done')\n");
  pool.stop();

  const f = hardening(freshInspect);
  const w = hardening(warmInspect);
  const expected = {
    NetworkMode: "none",
    ReadonlyRootfs: true,
    Tmpfs: { "/tmp": `rw,size=${SANDBOX_LIMITS.tmpfsSizeMb}m,noexec,nosuid` },
    CapDrop: [SANDBOX_LIMITS.capDrop],
    SecurityOpt: [SANDBOX_LIMITS.securityOpt],
    Memory: SANDBOX_LIMITS.memoryMb * 1024 * 1024,
    MemorySwap: SANDBOX_LIMITS.memoryMb * 1024 * 1024,
    NanoCpus: SANDBOX_LIMITS.cpus * 1e9,
    PidsLimit: SANDBOX_LIMITS.pidsLimit,
    Privileged: false,
    User: SANDBOX_LIMITS.user,
    AutoRemove: true,
  } as Record<string, unknown>;

  const rows: any[] = [];
  const diffs: string[] = [];
  for (const k of Object.keys(f)) {
    const fv = JSON.stringify((f as any)[k]);
    const wv = JSON.stringify((w as any)[k]);
    const ev = k in expected ? JSON.stringify(expected[k]) : "(not set by limits.ts)";
    const same = fv === wv;
    const matchesLimits = !(k in expected) || (fv === ev && wv === ev);
    if (!same || !matchesLimits) diffs.push(k);
    rows.push({ field: k, fresh: fv, warm: wv, limits_ts: ev, same, matches_limits: matchesLimits });
    console.log(`${same && matchesLimits ? "OK  " : "DIFF"} ${k.padEnd(14)} fresh=${fv}  warm=${wv}  limits.ts=${ev}`);
  }
  // Non-hardening differences, shown for transparency.
  const other = {
    fresh_binds: freshInspect.HostConfig.Binds,
    warm_binds: warmInspect.HostConfig.Binds,
    fresh_open_stdin: freshInspect.Config.OpenStdin,
    warm_open_stdin: warmInspect.Config.OpenStdin,
  };
  console.log("other (not hardening):", JSON.stringify(other));

  const verdict = diffs.length === 0 ? "identical hardening" : "MISMATCH";
  const out = {
    name: "b7-hardening-inspect",
    timestamp: new Date().toISOString(),
    conditions: { fresh: "runInDocker snapshot job (python sleep 3 s), inspected while running", warm: "WarmPool python container, inspected while READY" },
    rows,
    other_differences: other,
    summary: { verdict, fields_compared: rows.length, differences: diffs },
  };
  fs.writeFileSync(path.join(ROOT, "benchmarks/results/b7-hardening-inspect.json"), JSON.stringify(out, null, 1));
  console.log(`\n${verdict}: ${rows.length} fields compared, differences: ${diffs.join(", ") || "none"}`);
  await redis.quit();
  process.exit(diffs.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("B7 inspect FAILED:", e);
  process.exit(1);
});
