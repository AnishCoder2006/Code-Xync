import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/router";
import { ArrowRight, FlaskConical, Play, Users } from "lucide-react";
import { useAppAuth } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/display";

const FEATURES = [
  {
    icon: Users,
    title: "Edit together, live",
    body: "Everyone in the room types in the same file. Cursors, selections and presence update as you work, across server nodes.",
  },
  {
    icon: Play,
    title: "Run in a sandbox",
    body: "Run Python or JavaScript in a locked-down container: no network, capped memory and CPU, output streamed to the terminal.",
  },
  {
    icon: FlaskConical,
    title: "AI fixes you review",
    body: "Describe the bug. The AI edits a copy, tests it in the sandbox, retries if it fails, and shows you a diff. Nothing changes until you accept.",
  },
];

const SAMPLE = [
  { t: "def ", c: "text-primary" }, { t: "add", c: "text-highlight" }, { t: "(a, b):\n", c: "" },
  { t: "    return ", c: "text-primary" }, { t: "a + b", c: "" },
];

export default function Landing() {
  const { isLoaded, isSignedIn } = useAppAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoaded && isSignedIn) router.replace("/rooms");
  }, [isLoaded, isSignedIn, router]);

  return (
    <div className="relative" data-testid="landing">
      <div className="hero-lines pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="container relative grid gap-12 py-16 md:grid-cols-[1.15fr_1fr] md:items-center md:py-24">
        <section>
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border bg-card/70 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <span className="size-1.5 rounded-full bg-success" /> Real-time · Sandboxed · Verified AI
          </span>
          <h1 className="text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
            Write, run and fix code <span className="text-gradient">together.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
            CodeSync is a shared code editor with a sandboxed runner and an AI assistant that proves its fixes before
            you see them.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/sign-up">Create an account <ArrowRight /></Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </div>
        </section>

        <Card className="overflow-hidden bg-card/80 shadow-xl backdrop-blur" aria-hidden="true">
          <div className="flex items-center gap-1.5 border-b px-4 py-2.5">
            <span className="size-2.5 rounded-full bg-destructive/70" />
            <span className="size-2.5 rounded-full bg-warning/70" />
            <span className="size-2.5 rounded-full bg-success/70" />
            <span className="ml-3 font-mono text-xs text-muted-foreground">main.py</span>
            <span className="ml-auto flex -space-x-2">
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-[#0891b2] text-[10px] font-semibold text-white ring-2 ring-card">AL</span>
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-[#ea580c] text-[10px] font-semibold text-white ring-2 ring-card">BO</span>
            </span>
          </div>
          <pre className="m-0 whitespace-pre p-5 font-mono text-[13px] leading-6">
            {SAMPLE.map((s, i) => <span key={i} className={s.c}>{s.t}</span>)}
            <span className="relative ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 bg-[#ea580c]">
              <span className="absolute -top-4 left-0 rounded-sm bg-[#ea580c] px-1 text-[10px] font-semibold leading-4 text-white">Bo</span>
            </span>
          </pre>
          <div className="border-t bg-muted/50 px-5 py-3 font-mono text-xs">
            <span className="text-success">✓ verified</span> <span className="text-muted-foreground">· tests passed in sandbox · 2 attempts</span>
          </div>
        </Card>
      </div>

      <section aria-label="Features" className="container relative grid gap-4 pb-20 md:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <Card key={title} className="bg-card/80 p-6 backdrop-blur">
            <span className="mb-4 inline-flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <Icon className="size-4" />
            </span>
            <h3 className="mb-1.5 font-semibold">{title}</h3>
            <p className="text-muted-foreground">{body}</p>
          </Card>
        ))}
      </section>
    </div>
  );
}
