import type { GetStaticProps } from "next";
import { CheckCircle2, FlaskConical, Gauge, Search, ShieldCheck, Timer, XCircle, Zap } from "lucide-react";
import type { BenchData } from "../lib/benchmarks.server";
import { BarChart } from "../components/BarChart";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/display";

export const getStaticProps: GetStaticProps<{ data: BenchData }> = async () => {
  const { loadBenchmarks } = await import("../lib/benchmarks.server");
  return { props: { data: loadBenchmarks() } };
};

function Tile({ icon: Icon, label, value, hint }: { icon: typeof Zap; label: string; value: string; hint: string }) {
  return (
    <Card className="bg-card/90 p-5 backdrop-blur">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><Icon className="size-4" />{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </Card>
  );
}

function Section({ phase, title, desc, children }: { phase: string; title: string; desc: string; children: React.ReactNode }) {
  return (
    <Card className="bg-card/90 backdrop-blur">
      <CardHeader className="pb-4">
        <span className="text-xs font-semibold uppercase tracking-wide text-primary">{phase}</span>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription className="text-[15px]">{desc}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function BenchmarksPage({ data }: { data: BenchData }) {
  const h = data.headline;
  return (
    <div className="container py-10" data-testid="benchmarks-page">
      <div className="mb-8 max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight">How codexync performs</h1>
        <p className="mt-2 text-muted-foreground">
          Measured on one laptop (Windows, Docker Desktop) with every service, the load generator and the databases on the
          same machine, so absolute times are pessimistic. Each number comes from a recorded run in <code className="rounded bg-muted px-1 font-mono text-sm">benchmarks/results</code>;
          each timing comes from the run with the median p50 out of 3 measured runs after a warm-up (hover a bar for the range across runs).
        </p>
      </div>

      {data.found === 0 ? (
        <Card className="p-6 text-muted-foreground">No benchmark results were found when this site was built ({data.dir}).</Card>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="bench-headline">
            <Tile icon={ShieldCheck} label="AI safety invariant" value={h.safety ? `${h.safety.violations} / ${h.safety.trials}` : "—"} hint="Violations in randomized trials: the document only changed through a human Accept" />
            <Tile icon={FlaskConical} label="Sandbox attacks contained" value={h.attacks ? `${h.attacks.contained} / ${h.attacks.total}` : "—"} hint={h.attacks ? `Fork bomb, memory hog, network, file escapes… ${h.attacks.leftovers} leftover containers` : "Not recorded"} />
            <Tile icon={Search} label="Search: right function first" value={h.retrievalHit1 != null ? pct(h.retrievalHit1) : "—"} hint="Hybrid search, top result is the function the bug is in (25 cases)" />
            <Tile icon={Zap} label="Sandbox start, warm pool" value={h.warmStart ? `${h.warmStart.warmP50} ms` : "—"} hint={h.warmStart ? `Python p50, vs ${h.warmStart.freshP50} ms starting a new container` : "Not recorded"} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section phase="Phase 2 · Real-time sync" title="Edit reaches the other people (p95)" desc="Time from one person typing to everyone else in the room seeing it, through 2 sync nodes and Redis.">
              <BarChart bars={data.syncLatency} unit="ms" decimals={0} caption="95th percentile edit-to-peer latency, lower is better" />
            </Section>
            <Section phase="Phase 3 · Sandbox queue" title="Wait before a run starts, 100 at once (p95)" desc="Queue delay when 100 people press Run at the same moment, by how many runs a worker executes in parallel.">
              <BarChart bars={data.queueP95} unit="s" decimals={1} caption="95th percentile enqueue-to-start time, lower is better" />
            </Section>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section phase="Phase 3 · Sandbox" title="Time to first output (p50)" desc="A pre-started, single-use container (warm pool) removes container start-up from the wait.">
              <BarChart bars={data.sandboxStart} unit="ms" decimals={0} caption="Median time from job start to the program's first output, lower is better" />
            </Section>
            <Section phase="Phase 3 · Sandbox security" title="Attack payloads" desc="Each payload runs in the hardened sandbox: no network, read-only root, 256 MB, 64 processes, 5 s.">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="bench-attacks">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-1.5 pr-3 font-medium">Payload</th>
                      <th className="py-1.5 pr-3 font-medium">What happened</th>
                      <th className="py-1.5 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.attacks.map((a) => (
                      <tr key={a.payload} className="border-b last:border-0">
                        <td className="py-1.5 pr-3 font-mono text-xs">{a.payload}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{a.expected}</td>
                        <td className="py-1.5">
                          {a.passed ? (
                            <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="size-4" />Contained</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-medium text-destructive"><XCircle className="size-4" />Escaped</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>

          <Section phase="Phase 4 · Code search" title="Does search find the buggy function?" desc="25 bug descriptions searched against their code plus the matching test files as distractors.">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="bench-retrieval">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Chunking</th>
                    <th className="py-1.5 pr-3 font-medium">Method</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Right at #1</th>
                    <th className="py-1.5 pr-3 text-right font-medium">In top 3</th>
                    <th className="py-1.5 pr-3 text-right font-medium">MRR@10</th>
                    <th className="py-1.5 text-right font-medium">Queries answered</th>
                  </tr>
                </thead>
                <tbody>
                  {data.retrieval.map((r) => (
                    <tr key={r.chunking + r.mode} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">{r.chunking}</td>
                      <td className="py-1.5 pr-3 capitalize">{r.mode}{r.mode === "hybrid" ? <Badge variant="accent" className="ml-2">used</Badge> : null}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{pct(r.hit1)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{pct(r.hit3)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r.mrr.toFixed(2)}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.answered} / {r.queries}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {data.retrieval.some((r) => r.mode === "keyword" && r.answered === 0) &&
                "Keyword-only search answered none of the sentence-length queries, so hybrid search effectively relies on the vector side."}
              {data.retrievalLatency && ` Search latency with ${data.retrievalLatency.points}: hybrid p95 ${data.retrievalLatency.hybridP95.toFixed(0)} ms, vector-only p95 ${data.retrievalLatency.vectorP95.toFixed(0)} ms.`}
            </p>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section phase="Phase 5 · Verified AI fixes" title="The safety rule held" desc="Randomized fix requests (valid, wrong, malformed and prompt-injection answers) while two people kept typing.">
              <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 p-4">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
                <p className="text-[15px]">
                  {h.safety
                    ? `${h.safety.violations} violations in ${h.safety.trials} trials: no AI output reached the shared document without a person pressing Accept.`
                    : "No safety run recorded."}
                </p>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">Fix quality with a real model is not shown here: that evaluation needs an API key and has not been recorded yet.</p>
            </Section>
            <Section phase="Quality" title="End-to-end test runs" desc="Whole suites run three times in a row with retries off, so any flaky test shows up.">
              <ul className="grid gap-3" data-testid="bench-suites">
                {data.suites.map((s) => (
                  <li key={s.name} className="rounded-lg border p-3">
                    <div className="flex items-center gap-2 font-medium">
                      <Gauge className="size-4 text-muted-foreground" />{s.name}
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{s.what}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {s.runs.map((r) => (
                        <Badge key={r.run} variant={r.failed === 0 ? "success" : "destructive"}>
                          {r.failed === 0 ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
                          Run {r.run}: {r.passed}/{r.total}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          </div>

          <details className="rounded-xl border bg-card/90 p-5 backdrop-blur">
            <summary className="cursor-pointer font-medium"><Timer className="mr-2 inline size-4" />All queue measurements (p50 / p95)</summary>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Parallel runs per worker</th>
                    <th className="py-1.5 pr-3 font-medium">Runs submitted at once</th>
                    <th className="py-1.5 pr-3 text-right font-medium">p50</th>
                    <th className="py-1.5 text-right font-medium">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {data.queueGrid.map((g) => (
                    <tr key={`${g.concurrency}-${g.n}`} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">{g.concurrency}</td>
                      <td className="py-1.5 pr-3">{g.n}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{(g.p50 / 1000).toFixed(2)} s</td>
                      <td className="py-1.5 text-right tabular-nums">{(g.p95 / 1000).toFixed(2)} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
