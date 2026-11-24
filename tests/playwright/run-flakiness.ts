/**
 * Run the real-browser suite N times in a row (default 3) and record every result in
 * benchmarks/results/a2-browser-suite.json (read by benchmarks/report.py).
 *
 *   cd tests/playwright && NODE_ENV=test npx tsx run-flakiness.ts [--runs 3]
 *   npx tsx run-flakiness.ts --collect <dir>   # ingest runs already made: <dir>/browser-results-run<i>.json
 *                                              # and <dir>/browser-latency-run<i>.json
 * retries are 0 in playwright.config.ts, so every failure is visible.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { writeResult, stats, RunRecord } from "../../benchmarks/lib/bench";

const argv = process.argv;
const runsArg = argv.indexOf("--runs");
const N = runsArg > 0 ? Number(argv[runsArg + 1]) : 3;
const collectArg = argv.indexOf("--collect");
const HERE = __dirname;

interface SuiteRun {
  run: number;
  exit_code: number | null;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  duration_s: number;
  tests: Array<{ title: string; status: string; duration_ms: number }>;
}

function parseReport(file: string, run: number, exitCode: number | null): SuiteRun {
  const rep = JSON.parse(fs.readFileSync(file, "utf8"));
  const tests: SuiteRun["tests"] = [];
  const walk = (suite: any) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        tests.push({ title: `${spec.file} › ${spec.title}`, status: t.status, duration_ms: last?.duration ?? 0 });
      }
    }
  };
  for (const s of rep.suites ?? []) walk(s);
  const st = rep.stats ?? {};
  return {
    run,
    exit_code: exitCode,
    total: tests.length,
    passed: st.expected ?? tests.filter((t) => t.status === "expected").length,
    failed: st.unexpected ?? tests.filter((t) => t.status === "unexpected").length,
    flaky: st.flaky ?? 0,
    skipped: st.skipped ?? 0,
    duration_s: Math.round((st.duration ?? 0) / 100) / 10,
    tests,
  };
}

function main() {
  const suiteRuns: SuiteRun[] = [];
  const latRuns: RunRecord[] = [];
  let latConditions: any = null;
  if (collectArg > 0) {
    const dir = argv[collectArg + 1];
    for (let i = 1; fs.existsSync(path.join(dir, `browser-results-run${i}.json`)); i++) {
      // Exit code is not stored in the report; an all-expected report means exit 0.
      const r = parseReport(path.join(dir, `browser-results-run${i}.json`), i, null);
      r.exit_code = r.failed === 0 && r.flaky === 0 ? 0 : 1;
      suiteRuns.push(r);
      const lf = path.join(dir, `browser-latency-run${i}.json`);
      if (fs.existsSync(lf)) {
        const l = JSON.parse(fs.readFileSync(lf, "utf8"));
        latConditions = l.conditions;
        latRuns.push({ run: i, warmup: false, samples_ms: l.samples_ms, stats: stats(l.samples_ms) });
      }
    }
  } else {
    for (let i = 1; i <= N; i++) {
      let code = 0;
      try {
        execSync("npx playwright test", { cwd: HERE, stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
      } catch (e: any) {
        code = e.status ?? 1;
      }
      suiteRuns.push(parseReport(path.join(HERE, "test-results/browser-results.json"), i, code));
      const lf = path.join(HERE, "test-results/browser-latency.json");
      if (fs.existsSync(lf)) {
        const l = JSON.parse(fs.readFileSync(lf, "utf8"));
        latConditions = l.conditions;
        latRuns.push({ run: i, warmup: false, samples_ms: l.samples_ms, stats: stats(l.samples_ms) });
      }
    }
  }
  const file = writeResult("a2-browser-suite", {
    title: "Real-browser sync suite, consecutive runs (flakiness check)",
    sourceDirs: ["tests/playwright", "apps/web/src", "services/sync/src"],
    conditions: {
      what: "tests/playwright browser-*.spec.ts: Chromium contexts on /e2e/editor (Monaco + y-monaco), real sync nodes",
      topology: "2 sync nodes + Node LB (node-kill spec: its own private pair + LB), API for cross-node Accept, NEXT_PUBLIC_E2E=1 production build",
      retries: 0,
      workers: 1,
      consecutive_runs: suiteRuns.length,
    },
    protocol: "suite run back to back; no warm-up (pass/fail check); latency spec reports 30 samples per run",
    runs: suiteRuns.map((r) => ({ run: r.run, warmup: false, samples_ms: [], stats: stats([]), extra: r as any })),
    summary: {
      all_passed: suiteRuns.every((r) => r.exit_code === 0),
      runs: suiteRuns.map((r) => ({ run: r.run, exit_code: r.exit_code, passed: r.passed, failed: r.failed, flaky: r.flaky })),
    },
  });
  // report.py expects runs[] flattened with the suite fields; latency as its own block.
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.runs = suiteRuns;
  doc.latency = latRuns.length ? { conditions: latConditions, runs: latRuns } : null;
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  console.log(`wrote ${file}`);
  for (const r of suiteRuns) console.log(`  run ${r.run}: exit=${r.exit_code} ${r.passed}/${r.total} passed, ${r.failed} failed, ${r.flaky} flaky`);
}

main();
