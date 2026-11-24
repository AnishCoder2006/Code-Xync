import Link from "next/link";
import { ArrowUp } from "lucide-react";
import { useAppAuth } from "../lib/auth";
import { RUNNABLE } from "../lib/languages";
import { Logo } from "./AppShell";

const STACK = ["Next.js", "Yjs", "BullMQ", "Docker", "FastAPI", "LangGraph", "Qdrant", "Postgres", "Redis"];

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        className="relative inline-block py-0.5 text-[14px] text-muted-foreground transition-colors duration-200 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-300 hover:text-foreground hover:after:scale-x-100"
      >
        {children}
      </Link>
    </li>
  );
}

export function SiteFooter() {
  const { isSignedIn } = useAppAuth();
  return (
    <footer className="relative overflow-hidden border-t bg-card/60 backdrop-blur-md">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/70 to-transparent" />

      <div className="container grid gap-12 pb-10 pt-16 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1.2fr]">
        <div className="max-w-sm">
          <Logo />
          <p className="mt-4 text-[15px] text-muted-foreground">
            A shared editor, a locked-down sandbox, and an AI assistant that proves its fixes before anyone accepts them.
          </p>
          <p className="mt-5 inline-flex items-center gap-2 rounded-full border bg-background/60 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
            {RUNNABLE.length} runnable · 31 editable languages
          </p>
        </div>

        <nav aria-label="Product">
          <h2 className="eyebrow mb-4">Product</h2>
          <ul className="grid gap-2">
            {isSignedIn ? (
              <>
                <FooterLink href="/rooms">Rooms</FooterLink>
                <FooterLink href="/activity">Activity</FooterLink>
                <FooterLink href="/system">System status</FooterLink>
              </>
            ) : (
              <>
                <FooterLink href="/sign-up">Create an account</FooterLink>
                <FooterLink href="/sign-in">Sign in</FooterLink>
              </>
            )}
            <FooterLink href="/benchmarks">Benchmarks</FooterLink>
          </ul>
        </nav>

        <nav aria-label="Explore">
          <h2 className="eyebrow mb-4">Explore</h2>
          <ul className="grid gap-2">
            <FooterLink href="/#how">How it works</FooterLink>
            <FooterLink href="/#spec">Spec sheet</FooterLink>
            <FooterLink href="/benchmarks">Attack suite results</FooterLink>
          </ul>
        </nav>

        <div>
          <h2 className="eyebrow mb-4">Built with</h2>
          <ul className="flex flex-wrap gap-1.5">
            {STACK.map((s) => (
              <li
                key={s}
                className="rounded-md border bg-background/60 px-2 py-0.5 font-mono text-[12px] text-muted-foreground transition-colors duration-200 hover:border-foreground/25 hover:text-foreground"
              >
                {s}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none -mb-[0.14em] select-none text-center font-display text-[clamp(4.5rem,19vw,16rem)] font-extrabold leading-[0.85] tracking-[-0.05em]"
      >
        <span className="bg-gradient-to-b from-foreground/[0.11] to-foreground/0 bg-clip-text text-transparent">code</span>
        <span className="bg-gradient-to-b from-brand/60 to-brand/0 bg-clip-text italic text-transparent">x</span>
        <span className="bg-gradient-to-b from-foreground/[0.11] to-foreground/0 bg-clip-text text-transparent">ync</span>
      </div>

      <div className="relative border-t bg-background/40">
        <div className="container flex flex-wrap items-center justify-between gap-3 py-5 font-mono text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} codexync · a personal project</span>
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="group inline-flex items-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to top
            <ArrowUp className="size-3.5 transition-transform duration-300 group-hover:-translate-y-0.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </footer>
  );
}
