/**
 * Build-time loader for /benchmarks: reads benchmarks/results/*.json (Phase 6) and keeps
 * only what the page shows. Used from getStaticProps only, so `fs` never reaches the
 * browser. Every value is copied from the files; nothing is computed except picking the
 * recorded summary (median run) and simple ratios that are labelled as such.
 * BENCHMARKS_DIR overrides the location (default: <repo>/benchmarks/results).
 */
import fs from "fs";
import path from "path";

type Stats = { n: number; p50: number; p95: number; p99?: number };
export type Bar = { label: string; value: number; detail: string };

export type BenchData = {
  dir: string;
  found: number;
  generatedAt: string;
  headline: {
    safety: { violations: number; trials: number } | null;
    attacks: { contained: number; total: number; leftovers: number } | null;
    retrievalHit1: number | null;
    warmStart: { freshP50: number; warmP50: number } | null;
    uiRuns: { passed: number; runs: number } | null;
  };
  syncLatency: Bar[];
  queueP95: Bar[];
  queueGrid: { concurrency: number; n: number; p95: number; p50: number }[];
  sandboxStart: Bar[];
  retrieval: { chunking: string; mode: string; hit1: number; hit3: number; mrr: number; answered: number; queries: number }[];
  retrievalLatency: { hybridP95: number; vectorP95: number; points: string } | null;
  attacks: { payload: string; expected: string; actual: string; exitCode: number | null; passed: boolean; sandbox: string }[];
  suites: { name: string; what: string; runs: { run: number; passed: number; failed: number; total: number }[] }[];
};

const read = (dir: string, name: string): any | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  } catch {
    return null;
  }
};
/** Stats of the recorded "median run" (the measured run with the median p50). */
const median = (d: any): Stats | null => d?.summary?.median_stats ?? null;
/** p95 range across the measured runs, as recorded in summary.spread. */
const p95Range = (d: any, scale = 1, digits = 0): string => {
  const sp = d?.summary?.spread?.p95;
  return sp ? ` · p95 across runs ${(sp.min / scale).toFixed(digits)}–${(sp.max / scale).toFixed(digits)}` : "";
};

export function loadBenchmarks(): BenchData {
  const dir = process.env.BENCHMARKS_DIR || path.resolve(process.cwd(), "../../benchmarks/results");
  let found = 0;
  const get = (name: string) => {
    const d = read(dir, name);
    if (d) found++;
    return d;
  };

  // B1 sync latency
  const b1 = [
    ["b1-sync-latency-1room-10clients.json", "1 room · 10 people"],
    ["b1-sync-latency-1room-50clients.json", "1 room · 50 people"],
    ["b1-sync-latency-1room-100clients.json", "1 room · 100 people"],
    ["b1-sync-latency-50rooms-4clients.json", "50 rooms · 4 people each"],
  ] as const;
  const syncLatency: Bar[] = [];
  for (const [f, label] of b1) {
    const d = get(f);
    const s = median(d);
    if (s) syncLatency.push({ label, value: s.p95, detail: `p50 ${s.p50.toFixed(1)} ms · p95 ${s.p95.toFixed(1)} ms${p95Range(d)} ms · ${s.n.toLocaleString()} deliveries` });
  }

  // B2 queue
  const queueGrid: BenchData["queueGrid"] = [];
  const queueRange: Record<number, string> = {};
  for (const c of [1, 4, 8]) for (const n of [1, 10, 50, 100]) {
    const d = get(`b2-queue-c${c}-n${n}.json`);
    const s = median(d);
    if (s) queueGrid.push({ concurrency: c, n, p95: s.p95, p50: s.p50 });
    if (n === 100) queueRange[c] = p95Range(d, 1000, 1);
  }
  const queueP95: Bar[] = queueGrid
    .filter((g) => g.n === 100)
    .map((g) => ({ label: `${g.concurrency} ${g.concurrency === 1 ? "worker slot" : "worker slots"}`, value: g.p95 / 1000, detail: `100 runs submitted at once · p50 ${(g.p50 / 1000).toFixed(1)} s · p95 ${(g.p95 / 1000).toFixed(1)} s${queueRange[g.concurrency] ?? ""} s` }));

  // B2 / B7 sandbox start
  const sandboxStart: Bar[] = [];
  let warmStart: BenchData["headline"]["warmStart"] = null;
  for (const lang of ["python", "node"] as const) {
    const fresh = median(get(`b2-coldstart-${lang}.json`));
    const warm = median(get(`b7-coldstart-${lang}-warm.json`));
    const name = lang === "node" ? "JavaScript" : "Python";
    if (fresh) sandboxStart.push({ label: `${name}, new container`, value: fresh.p50, detail: `p50 ${fresh.p50} ms · p95 ${fresh.p95} ms` });
    if (warm) sandboxStart.push({ label: `${name}, warm pool`, value: warm.p50, detail: `p50 ${warm.p50} ms · p95 ${warm.p95} ms` });
    if (lang === "python" && fresh && warm) warmStart = { freshP50: fresh.p50, warmP50: warm.p50 };
  }

  // B3 retrieval
  const retrieval: BenchData["retrieval"] = [];
  for (const [f, chunking] of [["b3-retrieval-quality-ast.json", "Syntax-aware (functions)"], ["b3-retrieval-quality-window40.json", "Fixed 40-line windows"]] as const) {
    const d = get(f);
    for (const mode of ["vector", "keyword", "hybrid"]) {
      const m = d?.summary?.[mode];
      if (m) retrieval.push({ chunking, mode, hit1: m.hit_at_1, hit3: m.hit_at_3, mrr: m.mrr_at_10, answered: m.queries_with_any_result, queries: m.queries });
    }
  }
  const lat = get("b3-retrieval-latency-10k.json");
  const retrievalLatency = lat?.summary?.median_stats
    ? { hybridP95: lat.summary.median_stats.p95, vectorP95: lat.summary.median_run_vector_only_stats?.p95 ?? NaN, points: "10,000 indexed chunks in 20 rooms" }
    : null;
  const hybridAst = retrieval.find((r) => r.mode === "hybrid" && r.chunking.startsWith("Syntax"));

  // B6 safety
  const b6 = get("b6-safety-invariant.json");
  const safety = b6?.summary ? { violations: b6.summary.violations, trials: b6.summary.trials } : null;

  // B7 attacks
  const b7 = get("b7-attack-suite-warm.json");
  const attacks: BenchData["attacks"] = (b7?.results ?? []).map((r: any) => ({
    payload: r.payload, expected: r.expected, actual: r.actualStatus, exitCode: r.exitCode, passed: !!r.passed, sandbox: r.sandbox ?? "fresh",
  }));
  const attackHead = attacks.length
    ? { contained: attacks.filter((a) => a.passed).length, total: attacks.length, leftovers: (b7.results as any[]).reduce((s, r) => s + (r.leftoverContainers ?? 0), 0) }
    : null;

  // Suites
  const suites: BenchData["suites"] = [];
  for (const [f, name, what] of [
    ["ui-product-suite.json", "Product UI suite", "Real pages in Chromium: rooms, presence, viewer, Run, AI fix + stale patch"],
    ["a2-browser-suite.json", "Editor sync suite", "3 browsers on 2 nodes: convergence, offline, node kill, cross-node Accept"],
  ] as const) {
    const d = get(f);
    if (d?.runs) suites.push({ name, what, runs: d.runs.map((r: any) => ({ run: r.run, passed: r.passed, failed: r.failed, total: r.total })) });
  }
  const ui = suites.find((s) => s.name === "Product UI suite");

  return {
    dir: path.relative(process.cwd(), dir) || dir,
    found,
    generatedAt: new Date().toISOString(),
    headline: {
      safety,
      attacks: attackHead,
      retrievalHit1: hybridAst ? hybridAst.hit1 : null,
      warmStart,
      uiRuns: ui ? { passed: ui.runs.filter((r) => r.failed === 0).length, runs: ui.runs.length } : null,
    },
    syncLatency,
    queueP95,
    queueGrid,
    sandboxStart,
    retrieval,
    retrievalLatency,
    attacks,
    suites,
  };
}
