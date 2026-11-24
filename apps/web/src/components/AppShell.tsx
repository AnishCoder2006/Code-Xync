import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactNode } from "react";
import { UserMenu, useAppAuth } from "../lib/auth";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight", className)}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="cs-logo" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="hsl(var(--primary))" />
            <stop offset="1" stopColor="hsl(var(--highlight))" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="22" height="22" rx="6.5" fill="url(#cs-logo)" />
        <path d="M9.5 8 6 12l3.5 4M14.5 8 18 12l-3.5 4" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      CodeSync
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAppAuth();
  const router = useRouter();
  const onRooms = router.pathname.startsWith("/rooms") || router.pathname.startsWith("/room/");
  // The room page is a full-height workspace on solid surfaces; elsewhere the backdrop shows.
  const workspace = router.pathname.startsWith("/room/");

  return (
    <div className={cn("flex min-h-full flex-col", !workspace && "app-backdrop")}>
      <header className="sticky top-0 z-30 flex h-[var(--topbar-h)] items-center gap-6 border-b bg-card/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/70 sm:px-6">
        <Link href={isSignedIn ? "/rooms" : "/"} aria-label="CodeSync home" className="text-foreground">
          <Logo />
        </Link>
        {isSignedIn && (
          <nav aria-label="Main" className="flex gap-1">
            <Link
              href="/rooms"
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                onRooms ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              Rooms
            </Link>
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!isLoaded ? null : isSignedIn ? (
            <UserMenu />
          ) : (
            <>
              <Button asChild variant="ghost" size="sm"><Link href="/sign-in">Sign in</Link></Button>
              <Button asChild size="sm"><Link href="/sign-up">Sign up</Link></Button>
            </>
          )}
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
