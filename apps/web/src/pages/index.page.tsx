import Link from "next/link";
import type { GetStaticProps } from "next";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { useAppAuth } from "../lib/auth";
import { RUNNABLE } from "../lib/languages";
import { Button } from "../components/ui/button";
import { Reveal } from "../components/Reveal";

type Spec = { value: string; label: string; source: string };

/** Spec-sheet numbers come from the recorded benchmark files at build time. */
export const getStaticProps: GetStaticProps<{ specs: Spec[] }> = async () => {
  const { loadBenchmarks } = await import("../lib/benchmarks.server");
  const b = loadBenchmarks();
  const ten = b.syncLatency.find((s) => s.label.startsWith("1 room · 10"));
  const specs: Spec[] = [
    { value: ten ? `${Math.round(ten.value)} ms` : "—", label: "for an edit to reach 9 other people (p95)", source: "B1 · 2 sync nodes" },
    { value: b.headline.safety ? `${b.headline.safety.violations} / ${b.headline.safety.trials}` : "—", label: "AI outputs that changed code without a human Accept", source: "B6 · randomized trials" },
    { value: b.headline.attacks ? `${b.headline.attacks.contained} / ${b.headline.attacks.total}` : "—", label: "sandbox attacks contained, zero leaked containers", source: "B7 · attack suite" },
    { value: b.headline.retrievalHit1 != null ? `${Math.round(b.headline.retrievalHit1 * 100)}%` : "—", label: "searches where the buggy function ranks first", source: "B3 · 25 cases" },
    { value: b.headline.warmStart ? `${b.headline.warmStart.warmP50} ms` : "—", label: "from Run to first output with a warm sandbox (p50)", source: "B7 · warm pool" },
    { value: String(RUNNABLE.length), label: "languages that run in the sandbox, 31 you can edit", source: "worker registry" },
  ];
  return { props: { specs } };
};

const STEPS = [
  { n: "01", title: "Rooms and roles", body: "Invite by link, lock with a passcode, and decide who edits and who only watches. Role changes reach open editors at once." },
  { n: "02", title: "Live editing", body: "A CRDT keeps every copy of the file in agreement, across several sync servers, through dropped connections and node restarts." },
  { n: "03", title: "Hardened runs", body: "Each Run gets a fresh container with no network, a read-only disk, and hard limits on memory, processes and time." },
  { n: "04", title: "Search by meaning", body: "Ask “where is the total computed” and land on the function. Embeddings and names are ranked together." },
  { n: "05", title: "Fixes that prove themselves", body: "The AI edits a copy, runs it, retries on failure, and shows a diff. If the file changed meanwhile, the patch is refused." },
  { n: "06", title: "Measured in public", body: "Latency, queueing, attack containment and search quality are recorded and published, misses included." },
];

/** A remote cursor: caret bar plus a name flag to its right (end of line, so nothing is covered). */
function Caret({ name, className, bar }: { name: string; className: string; bar: string }) {
  return (
    <span className="relative inline-block w-0 align-baseline">
      <span className={`caret-blink absolute -top-[15px] left-0 h-[19px] w-0.5 ${bar}`} />
      <span className={`absolute -top-[14px] left-1.5 whitespace-nowrap rounded-[3px] px-1 font-sans text-[10px] font-semibold leading-4 ${className}`}>{name}</span>
    </span>
  );
}

function ProductVisual() {
  return (
    <div className="float-in relative rounded-xl border bg-card/40 p-5 backdrop-blur-sm [--d:200ms] sm:p-8" aria-hidden="true">
      <div className="ruled absolute inset-0 rounded-xl [mask-image:radial-gradient(ellipse_at_center,#000_40%,transparent_85%)]" />
      <div className="relative overflow-hidden rounded-lg border bg-card shadow-[0_1px_0_hsl(var(--foreground)/0.04),0_30px_60px_-24px_hsl(var(--foreground)/0.45)] transition-transform duration-700 [transition-timing-function:var(--ease-out)] hover:-translate-y-1">
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </span>
          <span className="font-mono text-xs">invoice.py</span>
          <span className="rounded-[4px] border px-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">python</span>
          <span className="ml-auto flex -space-x-1.5">
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-brand font-mono text-[10px] font-semibold text-brand-foreground ring-2 ring-card">AS</span>
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-cobalt font-mono text-[10px] font-semibold text-white ring-2 ring-card">RP</span>
          </span>
        </div>
        <pre className="m-0 overflow-hidden px-0 py-3 font-mono text-[12.5px] leading-6">
          {[
            ["1", <><span className="text-cobalt">def</span> total(items):</>],
            ["2", <>    subtotal = <span className="text-cobalt">sum</span>(i.price * i.qty <span className="text-cobalt">for</span> i <span className="text-cobalt">in</span> items)</>],
            ["3", <>    <span className="text-cobalt">return</span> round(subtotal * 1.18, 2)<Caret name="Ana" className="bg-brand text-brand-foreground" bar="bg-brand" /></>],
            ["4", ""],
            ["5", <><span className="text-muted-foreground"># tax rate is per region</span><Caret name="Raj" className="bg-cobalt text-white" bar="bg-cobalt" /></>],
          ].map(([n, code]) => (
            <div key={n as string} className="flex">
              <span className="w-10 shrink-0 select-none pr-3 text-right text-muted-foreground/70">{n}</span>
              <span className="whitespace-pre">{code}</span>
            </div>
          ))}
        </pre>
        <div className="border-t bg-muted/60 px-4 py-2.5 pb-8 font-mono text-xs">
          <span className="text-muted-foreground">$ run main.py</span>
          <br />
          <span className="text-success">exit 0</span>
        </div>
      </div>
      <div className="float-in absolute -bottom-7 right-2 w-64 rounded-lg border bg-card/95 p-3 text-xs shadow-[0_24px_48px_-16px_hsl(var(--brand)/0.45)] ring-1 ring-brand/30 backdrop-blur [--d:1100ms] sm:-right-6">
        <div className="mb-2 flex items-center justify-between font-mono uppercase tracking-wide text-muted-foreground">
          <span>AI fix · attempt 2</span>
          <span className="inline-flex items-center gap-1.5 text-success">
            <span className="live-dot size-1.5 rounded-full bg-success" />
            ran clean
          </span>
        </div>
        <div className="space-y-0.5 font-mono">
          <div className="rounded-sm bg-destructive/10 px-1.5 text-destructive">- subtotal * 1.18</div>
          <div className="rounded-sm bg-success/10 px-1.5 text-success">+ subtotal * rate</div>
        </div>
      </div>
    </div>
  );
}

export default function Landing({ specs }: { specs: Spec[] }) {
  // No redirect: the landing page is always reachable; signed-in visitors get a shortcut instead.
  const { isLoaded, isSignedIn } = useAppAuth();

  return (
    <div data-testid="landing">
      <section className="container grid grid-cols-[minmax(0,1fr)] gap-16 pb-20 pt-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:pb-28 lg:pt-20">
        <div>
          <p className="rise mb-7 inline-flex items-center gap-2.5 rounded-full border bg-card/70 py-1 pl-2 pr-3.5 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.05)] backdrop-blur">
            <span className="live-dot size-2 rounded-full bg-success" aria-hidden="true" />
            Collaborative editor · sandbox · verified AI
          </p>
          <h1 className="rise text-[44px] font-bold leading-[1.02] [--d:90ms] sm:text-[64px]">
            Write code together. Accept only fixes that <span className="draw-underline [--d:750ms]">run</span>.
          </h1>
          <p className="rise mt-6 max-w-xl text-lg text-muted-foreground [--d:180ms]">
            A shared editor with a locked-down runner and an AI assistant that tests its own changes before you ever see a
            diff. Nothing touches the file until a person says yes.
          </p>
          <div className="rise mt-9 flex flex-wrap items-center gap-3 [--d:270ms]">
            {isLoaded && isSignedIn ? (
              <>
                <Button asChild size="lg" variant="brand">
                  <Link href="/rooms">Go to your rooms <ArrowRight /></Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/benchmarks">See the numbers</Link>
                </Button>
              </>
            ) : (
              <>
                <Button asChild size="lg" variant="brand">
                  <Link href="/sign-up">Start a room <ArrowRight /></Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/sign-in">Sign in</Link>
                </Button>
              </>
            )}
          </div>
        </div>
        <ProductVisual />
      </section>

      <section id="spec" className="scroll-mt-16 border-y bg-card/75 backdrop-blur-md" aria-labelledby="spec-title">
        <div className="container py-16">
          <Reveal className="mb-9 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="eyebrow mb-2">Spec sheet</p>
              <h2 id="spec-title" className="text-3xl font-semibold sm:text-4xl">Measured, not claimed.</h2>
            </div>
            <Link href="/benchmarks" className="group inline-flex items-center gap-1 font-mono text-sm font-medium text-cobalt underline-offset-4 hover:underline">
              Every benchmark, with conditions
              <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            </Link>
          </Reveal>
          <dl className="grid overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-3" data-testid="spec-sheet">
            {specs.map((s, i) => (
              <Reveal
                key={s.label}
                delay={i * 70}
                className="group relative -mb-px -mr-px border-b border-r p-7 transition-colors duration-300 hover:bg-background/70"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[3px] origin-left scale-x-0 bg-brand transition-transform duration-500 [transition-timing-function:var(--ease-out)] group-hover:scale-x-100"
                />
                <dd className="font-display text-[44px] font-semibold leading-none tracking-tight tabular-nums">{s.value}</dd>
                <dt className="mt-3 text-[15px]">{s.label}</dt>
                <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors duration-300 group-hover:text-foreground">
                  {s.source}
                </p>
              </Reveal>
            ))}
          </dl>
        </div>
      </section>

      <section id="how" className="container scroll-mt-16 py-20" aria-labelledby="how-title">
        <Reveal>
          <p className="eyebrow mb-2">How it works</p>
          <h2 id="how-title" className="mb-10 text-3xl font-semibold sm:text-4xl">Six parts, one room.</h2>
        </Reveal>
        <ol className="grid gap-x-12 md:grid-cols-2">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.n} delay={(i % 2) * 90} className="group grid grid-cols-[3.5rem_1fr] gap-2 border-t py-7">
              <span className="inline-flex h-7 w-10 items-center justify-center rounded-md border font-mono text-[13px] text-brand transition-all duration-300 group-hover:border-brand group-hover:bg-brand group-hover:text-brand-foreground">
                {s.n}
              </span>
              <div className="transition-transform duration-500 [transition-timing-function:var(--ease-out)] group-hover:translate-x-1">
                <h3 className="text-xl font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-muted-foreground">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
      </section>

      <Reveal as="section" className="container pb-20">
        <div className="relative overflow-hidden rounded-2xl border bg-foreground px-8 py-12 text-background dark:bg-card dark:text-foreground sm:px-12">
          <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-brand/40 blur-3xl" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 left-1/3 size-72 rounded-full bg-cobalt/30 blur-3xl" />
          <div className="relative flex flex-wrap items-center justify-between gap-6">
            <div>
              <h2 className="text-3xl font-semibold sm:text-4xl">Open a room. Invite one person.</h2>
              <p className="mt-2 max-w-lg text-background/70 dark:text-muted-foreground">Edit together, run it in the sandbox, and let the AI prove its fix before you accept it.</p>
            </div>
            <Button asChild size="lg" variant="brand">
              <Link href={isLoaded && isSignedIn ? "/rooms" : "/sign-up"}>{isLoaded && isSignedIn ? "Open your rooms" : "Create a free room"} <ArrowRight /></Link>
            </Button>
          </div>
        </div>
      </Reveal>

    </div>
  );
}
