import type { CSSProperties, ReactNode } from "react";
import { ShieldCheck, Sparkles, Users, type LucideIcon } from "lucide-react";
import { Wordmark } from "./AppShell";

type Mode = "sign-in" | "sign-up";

const COPY: Record<Mode, { kicker: string; title: ReactNode; body: string; formTitle: string; formSubtitle: string }> = {
  "sign-in": {
    kicker: "Welcome back",
    title: <>Pick up right where your room left off.</>,
    body: "Your files, collaborators, run history and AI fixes are all where you left them.",
    formTitle: "Sign in to CodeSync",
    formSubtitle: "Welcome back! Choose how you'd like to continue.",
  },
  "sign-up": {
    kicker: "Create your account",
    title: <>Your first shared room is a minute away.</>,
    body: "Invite someone with a link, decide who edits and who watches, and run the code together.",
    formTitle: "Create your CodeSync account",
    formSubtitle: "Start collaborating in under a minute.",
  },
};

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Users, title: "Live editing, named cursors", body: "Every edit merges instantly, across sync servers and dropped connections." },
  { icon: ShieldCheck, title: "A locked-down sandbox", body: "No network, a read-only disk and hard limits on memory, processes and time." },
  { icon: Sparkles, title: "AI fixes that prove themselves", body: "Each fix is run before you see the diff, and nothing lands without your Accept." },
];

function LiveRoomCard() {
  return (
    <div className="float-in rounded-xl border bg-background/70 p-4 shadow-[0_20px_40px_-24px_hsl(var(--foreground)/0.5)] backdrop-blur [--d:700ms]" aria-hidden="true">
      <div className="flex items-center gap-3">
        <span className="flex -space-x-2">
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-brand font-mono text-[11px] font-semibold text-brand-foreground ring-2 ring-background">AS</span>
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-cobalt font-mono text-[11px] font-semibold text-white ring-2 ring-background">RP</span>
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-success font-mono text-[11px] font-semibold text-success-foreground ring-2 ring-background">MK</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">3 people in “Pagination bug hunt”</p>
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            Raj is typing
            <span className="inline-flex gap-0.5">
              <span className="typing-dot size-1 rounded-full bg-current" />
              <span className="typing-dot size-1 rounded-full bg-current [animation-delay:150ms]" />
              <span className="typing-dot size-1 rounded-full bg-current [animation-delay:300ms]" />
            </span>
          </p>
        </div>
        <span className="live-dot size-2 rounded-full bg-success" />
      </div>
    </div>
  );
}

/** Split auth screen: brand story on the left (desktop), the sign-in / sign-up form on the right. */
export function AuthLayout({ mode, children }: { mode: Mode; children: ReactNode }) {
  const c = COPY[mode];
  return (
    <div className="container grid flex-1 grid-cols-[minmax(0,1fr)] items-center gap-12 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-20 lg:py-16">
      <aside className="relative hidden overflow-hidden rounded-2xl border bg-card/60 p-10 backdrop-blur-sm lg:block">
        <div aria-hidden="true" className="ruled pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_top_left,#000_10%,transparent_70%)]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -right-24 size-72 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative">
          <p className="rise eyebrow">{c.kicker}</p>
          <h1 className="rise mt-4 max-w-md text-[40px] font-bold leading-[1.05] [--d:80ms]">{c.title}</h1>
          <p className="rise mt-4 max-w-md text-muted-foreground [--d:160ms]">{c.body}</p>
          <ul className="mt-10 grid gap-6">
            {FEATURES.map((f, i) => (
              <li key={f.title} className="rise flex gap-4" style={{ "--d": `${240 + i * 90}ms` } as CSSProperties}>
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background/70 text-brand">
                  <f.icon className="size-[18px]" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-medium">{f.title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-10 max-w-sm">
            <LiveRoomCard />
          </div>
        </div>
      </aside>

      <div className="float-in mx-auto w-full max-w-[440px] [--d:120ms]">
        <div className="mb-6 text-center lg:hidden">
          <Wordmark className="text-2xl font-semibold" />
          <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
        </div>
        {/* One card for every auth form; the form inside (Clerk or the test build's) brings no card of its own. */}
        <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-[0_30px_60px_-30px_hsl(var(--foreground)/0.45)]">
          <div className="px-6 pt-7 sm:px-8 sm:pt-8">
            <h2 className="font-display text-2xl font-semibold tracking-tight">{c.formTitle}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{c.formSubtitle}</p>
          </div>
          <div className="px-6 pb-6 pt-6 sm:px-8 sm:pb-7">{children}</div>
        </div>
      </div>
    </div>
  );
}
