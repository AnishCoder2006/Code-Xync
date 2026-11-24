/**
 * Shared helpers for Phase 6 benchmarks (Node side). Every result file written by
 * writeResult() has the same envelope, which benchmarks/report.py reads:
 *
 *   { name, title, timestamp, git, environment, conditions, protocol,
 *     runs: [{ run, warmup, samples_ms, stats, extra }], summary, notes }
 *
 * Percentiles use the nearest-rank method on the raw samples (no interpolation).
 */
import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const ROOT = path.resolve(__dirname, "../..");
export const RESULTS_DIR = path.join(ROOT, "benchmarks/results");

export interface Stats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    n: s.length,
    min: r(s[0] ?? NaN),
    p50: r(percentile(s, 50)),
    p95: r(percentile(s, 95)),
    p99: r(percentile(s, 99)),
    max: r(s[s.length - 1] ?? NaN),
    mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}

const sh = (cmd: string) => {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
};

/** Hash of the source trees a benchmark exercises (identifies code when there is no commit). */
export function sourceDigest(dirs: string[]): string {
  const h = crypto.createHash("sha256");
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", "dist", ".next", ".next-e2e", "__pycache__", ".venv", "test-results"].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        h.update(path.relative(ROOT, p).replace(/\\/g, "/"));
        h.update(fs.readFileSync(p));
      }
    }
  };
  dirs.forEach((d) => walk(path.join(ROOT, d)));
  return h.digest("hex").slice(0, 16);
}

export function gitInfo(dirs: string[]) {
  const head = sh("git rev-parse --verify -q HEAD");
  const dirty = sh("git status --porcelain");
  return {
    commit: head,
    commit_note: head ? null : "branch main has no commits yet; numbers come from the uncommitted working tree",
    last_pushed_commit: sh("git rev-parse --verify -q origin/main"),
    uncommitted_paths: dirty === null ? null : dirty.split("\n").filter(Boolean).length,
    source_digest: sourceDigest(dirs),
    source_digest_dirs: dirs,
  };
}

export function environment() {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    cpu: `${cpus[0]?.model ?? "?"}`,
    logical_cpus: cpus.length,
    ram_gib: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    node: process.version,
    docker: sh('docker version --format "client {{.Client.Version}} / server {{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})"'),
    docker_desktop_note:
      os.platform() === "win32"
        ? "Docker Desktop on Windows: containers run in the WSL2 VM; Redis/Postgres/Qdrant and sandboxes cross the Windows<->VM boundary"
        : null,
    load_generator_shares_machine: true,
    memory_at_start: memorySnapshot(),
  };
}

/**
 * System memory pressure when the benchmark started (Windows performance counters).
 * Recorded because on this machine Docker container start time varies several-fold with
 * paging (measured: ~1.5 s vs ~6 s for the same single `docker run`).
 */
export function memorySnapshot(): Record<string, number | string | null> {
  if (os.platform() !== "win32") return { free_mib: Math.round(os.freemem() / 2 ** 20) };
  const ps = sh(
    `powershell -NoProfile -Command "(Get-Counter '\\Memory\\Available MBytes','\\Memory\\Committed Bytes','\\Memory\\Commit Limit','\\Memory\\Pages/sec').CounterSamples | ForEach-Object { $_.CookedValue }"`
  );
  const v = (ps ?? "").split(/\r?\n/).map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
  if (v.length < 4) return { available_mib: null, note: "counters unavailable" };
  return {
    available_mib: Math.round(v[0]),
    committed_gib: Math.round((v[1] / 2 ** 30) * 10) / 10,
    commit_limit_gib: Math.round((v[2] / 2 ** 30) * 10) / 10,
    pages_per_sec: Math.round(v[3]),
  };
}

export interface RunRecord {
  run: number;
  warmup: boolean;
  samples_ms: number[];
  stats: Stats;
  extra?: Record<string, unknown>;
}

/** Pick the measured run whose p50 is the median of the measured runs; report spread. */
export function summarize(runs: RunRecord[]) {
  const measured = runs.filter((r) => !r.warmup && r.samples_ms.length > 0);
  if (measured.length === 0) return { median_run: null, spread: null };
  const byP50 = [...measured].sort((a, b) => a.stats.p50 - b.stats.p50);
  const median = byP50[Math.floor((byP50.length - 1) / 2)];
  const range = (k: keyof Stats) => {
    const v = measured.map((r) => r.stats[k] as number);
    return { min: Math.min(...v), max: Math.max(...v) };
  };
  return {
    median_run: median.run,
    median_stats: median.stats,
    spread: { p50: range("p50"), p95: range("p95"), p99: range("p99") },
  };
}

export function writeResult(
  name: string,
  body: {
    title: string;
    conditions: Record<string, unknown>;
    protocol: string;
    runs: RunRecord[];
    notes?: string[];
    sourceDirs: string[];
    summary?: Record<string, unknown>;
  }
) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = {
    name,
    title: body.title,
    timestamp: new Date().toISOString(),
    git: gitInfo(body.sourceDirs),
    environment: environment(),
    conditions: body.conditions,
    protocol: body.protocol,
    runs: body.runs,
    summary: body.summary ?? summarize(body.runs),
    notes: body.notes ?? [],
  };
  const file = path.join(RESULTS_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  return file;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
