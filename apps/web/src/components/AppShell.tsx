import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Activity, BarChart3, Gauge, Layers, LayoutGrid, Menu, Server, X, type LucideIcon } from "lucide-react";
import { UserMenu, useAppAuth } from "../lib/auth";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { SiteFooter } from "./SiteFooter";
import { ThemeToggle } from "./ThemeToggle";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The name, with the x as the signal: "code x sync". */
export function Wordmark({ className, xClassName }: { className?: string; xClassName?: string }) {
  return (
    <span className={cn("font-display tracking-tight", className)} aria-label="codexync">
      <span aria-hidden="true">
        code
        <span
          className={cn(
            "mx-[0.01em] inline-block font-extrabold italic text-brand transition-transform duration-500 [transition-timing-function:var(--ease-spring)] group-hover/logo:rotate-[18deg] group-hover/logo:scale-110",
            xClassName
          )}
        >
          x
        </span>
        ync
      </span>
    </span>
  );
}

/** Mark: two carets, the second with a name flag — two people in one file. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("group/logo inline-flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 28 28" className="size-7 shrink-0" aria-hidden="true">
        <rect width="28" height="28" rx="8" className="fill-foreground" />
        <rect x="8" y="7" width="2.6" height="14" rx="1.3" className="fill-background" />
        <g className="transition-transform duration-500 [transition-timing-function:var(--ease-spring)] group-hover/logo:translate-x-[2px]">
          <rect x="15" y="10" width="2.6" height="11" rx="1.3" className="fill-brand" />
          <rect x="15" y="7" width="6.5" height="4.2" rx="1.4" className="fill-brand" />
        </g>
      </svg>
      <Wordmark className="text-[18px] font-semibold" />
    </span>
  );
}

type NavItem = { href: string; label: string; icon: LucideIcon; active: boolean };
type Box = { x: number; w: number };

/** Pill navigation: a solid indicator slides to the current page, a soft one follows the pointer. */
function NavPills({ items }: { items: NavItem[] }) {
  const navRef = useRef<HTMLElement>(null);
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [active, setActive] = useState<Box | null>(null);
  const [hover, setHover] = useState<{ box: Box | null; on: boolean; jump: boolean }>({ box: null, on: false, jump: true });
  const activeIdx = items.findIndex((i) => i.active);

  const measure = useCallback((i: number): Box | null => {
    const el = linkRefs.current[i];
    return el ? { x: el.offsetLeft, w: el.offsetWidth } : null;
  }, []);

  useIsoLayoutEffect(() => {
    const update = () => setActive(activeIdx >= 0 ? measure(activeIdx) : null);
    update();
    const ro = new ResizeObserver(update);
    if (navRef.current) ro.observe(navRef.current);
    return () => ro.disconnect();
  }, [activeIdx, measure, items.length]);

  useEffect(() => {
    if (!hover.jump || !hover.on) return;
    const id = requestAnimationFrame(() => setHover((h) => ({ ...h, jump: false })));
    return () => cancelAnimationFrame(id);
  }, [hover.jump, hover.on]);

  const slide = "transform 420ms var(--ease-out), width 420ms var(--ease-out)";

  return (
    <nav
      ref={navRef}
      aria-label="Main"
      onMouseLeave={() => setHover((h) => ({ ...h, on: false, jump: true }))}
      className="relative flex items-center gap-0.5 rounded-full border bg-card/70 p-1 shadow-[0_1px_2px_hsl(var(--foreground)/0.06)] backdrop-blur"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-1 left-0 rounded-full bg-foreground/[0.07]"
        style={{
          width: hover.box?.w ?? 0,
          transform: `translateX(${hover.box?.x ?? 0}px)`,
          opacity: hover.on ? 1 : 0,
          transition: hover.jump ? "opacity 160ms ease-out" : `${slide}, opacity 160ms ease-out`,
        }}
      />
      {active && (
        <span
          aria-hidden="true"
          data-testid="nav-indicator"
          className="absolute inset-y-1 left-0 rounded-full bg-foreground shadow-[0_2px_10px_-2px_hsl(var(--foreground)/0.45)]"
          style={{ width: active.w, transform: `translateX(${active.x}px)`, transition: slide }}
        />
      )}
      {items.map((n, i) => {
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href}
            ref={(el) => { linkRefs.current[i] = el; }}
            aria-current={n.active ? "page" : undefined}
            onMouseEnter={() => {
              const box = measure(i);
              if (box) setHover((h) => ({ box, on: true, jump: !h.on }));
            }}
            className={cn(
              "relative z-10 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13.5px] font-medium outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-ring",
              n.active ? "text-background" : "text-muted-foreground hover:text-foreground",
              // Before the indicator is measured (first paint), the active link draws its own pill.
              n.active && !active && "bg-foreground"
            )}
          >
            <Icon className={cn("size-[15px] transition-colors duration-300", n.active && "text-brand")} aria-hidden="true" />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

function MobileMenu({ items, onClose }: { items: NavItem[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="absolute inset-x-0 top-full border-b bg-background shadow-[0_24px_40px_-20px_hsl(var(--foreground)/0.5)] duration-200 animate-in fade-in slide-in-from-top-2 md:hidden">
      <nav aria-label="Main" className="container grid gap-1 py-3">
        {items.map((n, i) => {
          const Icon = n.icon;
          return (
            <Link
              key={n.href}
              href={n.href}
              onClick={onClose}
              aria-current={n.active ? "page" : undefined}
              style={{ animationDelay: `${40 + i * 35}ms` }}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-medium duration-300 animate-in fade-in slide-in-from-top-1 fill-mode-both",
                n.active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              )}
            >
              <Icon className={cn("size-4", n.active && "text-brand")} aria-hidden="true" />
              {n.label}
              {n.active && <span className="ml-auto size-1.5 rounded-full bg-brand" aria-hidden="true" />}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Ambient page background: dot grid fading out from the top, three slow light fields, grain. */
function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="backdrop-grid absolute inset-0" />
      <div className="glow glow-a" />
      <div className="glow glow-b" />
      <div className="glow glow-c" />
      <div className="backdrop-grain absolute inset-0" />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAppAuth();
  const router = useRouter();
  const path = router.pathname;
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // show: "in" = signed-in only, "out" = signed-out only (landing sections), "all".
  const items: NavItem[] = [
    { href: "/#how", label: "How it works", icon: Layers, active: false, show: "out" },
    { href: "/#spec", label: "Spec sheet", icon: Gauge, active: false, show: "out" },
    { href: "/rooms", label: "Rooms", icon: LayoutGrid, active: path.startsWith("/rooms") || path.startsWith("/room/"), show: "in" },
    { href: "/activity", label: "Activity", icon: Activity, active: path === "/activity", show: "in" },
    { href: "/system", label: "System", icon: Server, active: path === "/system", show: "in" },
    { href: "/benchmarks", label: "Benchmarks", icon: BarChart3, active: path === "/benchmarks", show: "all" },
  ].filter((n) => n.show === "all" || n.show === (isSignedIn ? "in" : "out"));

  // The room page is a full-height workspace on solid surfaces; elsewhere the backdrop shows.
  const workspace = path.startsWith("/room/");
  const solid = workspace || scrolled || menuOpen;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    router.events.on("routeChangeStart", closeMenu);
    return () => router.events.off("routeChangeStart", closeMenu);
  }, [router.events, closeMenu]);

  return (
    <div className="relative isolate flex min-h-full flex-col">
      {!workspace && <Backdrop />}
      <header
        className={cn(
          "sticky top-0 z-40 h-[var(--topbar-h)] border-b transition-[background-color,border-color,box-shadow] duration-500",
          menuOpen
            ? "border-border bg-background"
            : solid
            ? "border-border/80 bg-background/75 shadow-[0_10px_30px_-18px_hsl(var(--foreground)/0.35)] backdrop-blur-xl backdrop-saturate-150"
            : "border-transparent bg-transparent"
        )}
      >
        <div className={cn("flex h-full items-center gap-4 md:grid md:grid-cols-[1fr_auto_1fr]", workspace ? "px-4 sm:px-5" : "container")}>
          <Link href="/" aria-label="codexync home" className="justify-self-start rounded-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Logo />
          </Link>
          <div className="hidden md:block">
            <NavPills items={items} />
          </div>
          <div className="ml-auto flex items-center gap-2 justify-self-end">
            <ThemeToggle />
            {!isLoaded ? null : isSignedIn ? (
              <UserMenu />
            ) : (
              <>
                <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex"><Link href="/sign-in">Sign in</Link></Button>
                <Button asChild size="sm"><Link href="/sign-up">Sign up</Link></Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span className="relative size-4">
                <Menu className={cn("absolute inset-0 transition-all duration-300", menuOpen ? "rotate-90 scale-50 opacity-0" : "opacity-100")} />
                <X className={cn("absolute inset-0 transition-all duration-300", menuOpen ? "opacity-100" : "-rotate-90 scale-50 opacity-0")} />
              </span>
            </Button>
          </div>
        </div>
        {menuOpen && <MobileMenu items={items} onClose={closeMenu} />}
      </header>
      <main key={path} className={cn("flex min-h-0 flex-1 flex-col", workspace ? "page-fade" : "page-enter")}>
        {children}
      </main>
      {!workspace && !path.startsWith("/sign-") && <SiteFooter />}
    </div>
  );
}
