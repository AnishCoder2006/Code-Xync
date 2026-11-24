/**
 * CODESYNC_TEST_AUTH — test-only auth. Compiled ONLY into NEXT_PUBLIC_E2E=1 builds, where
 * next.config.js replaces src/lib/auth/clerkAuth.tsx with this file. Production builds
 * never contain it (tests/test-a4-prod-404.ts scans the output for the marker above).
 *
 * Identity comes from the URL once and is then kept in localStorage:
 *   ?as=<userId>[&name=<display name>]   sign in as that user (must exist in the DB)
 *   ?syncUrl=ws://host:port              pin this tab's sync WebSocket to one node
 * Tokens are "test-token-<userId>", accepted only by services running with NODE_ENV=test.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { ArrowRight, FlaskConical } from "lucide-react";
import type { AppAuth, AppUser, AuthModule } from "../lib/auth/types";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/form";

const USER_KEY = "codesync:e2e-user";
const SYNC_KEY = "codesync:e2e-sync-url";

type Ctx = AppAuth & { signIn: (u: AppUser) => void; signOut: () => void; syncUrl?: string };
const AuthCtx = createContext<Ctx | null>(null);

const read = (store: Storage, key: string) => {
  try { return store.getItem(key); } catch { return null; }
};
const write = (store: Storage, key: string, value: string | null) => {
  try { value === null ? store.removeItem(key) : store.setItem(key, value); } catch { /* storage blocked */ }
};

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [syncUrl, setSyncUrl] = useState<string | undefined>();
  const [isLoaded, setLoaded] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const as = q.get("as");
    if (as) write(localStorage, USER_KEY, JSON.stringify({ id: as, name: q.get("name") || as }));
    const s = q.get("syncUrl");
    if (s) write(sessionStorage, SYNC_KEY, s);
    const raw = read(localStorage, USER_KEY);
    try { setUser(raw ? JSON.parse(raw) : null); } catch { setUser(null); }
    setSyncUrl(read(sessionStorage, SYNC_KEY) || undefined);
    setLoaded(true);
  }, []);

  const signIn = useCallback((u: AppUser) => {
    write(localStorage, USER_KEY, JSON.stringify(u));
    setUser(u);
  }, []);
  const signOut = useCallback(() => {
    write(localStorage, USER_KEY, null);
    setUser(null);
  }, []);
  const getToken = useCallback(async () => (user ? `test-token-${user.id}` : null), [user]);

  const value = useMemo<Ctx>(
    () => ({ isLoaded, isSignedIn: !!user, user, getToken, signIn, signOut, syncUrl }),
    [isLoaded, user, getToken, signIn, signOut, syncUrl]
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

function useCtx(): Ctx {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("testAuth: AuthProvider missing");
  return c;
}

function useAppAuth(): AppAuth {
  const { isLoaded, isSignedIn, user, getToken } = useCtx();
  return useMemo(() => ({ isLoaded, isSignedIn, user, getToken }), [isLoaded, isSignedIn, user, getToken]);
}

function UserMenu() {
  const { user, signOut } = useCtx();
  const router = useRouter();
  const initials = (user?.name ?? "?").split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-card/70 py-0.5 pl-0.5 pr-1 shadow-[0_1px_2px_hsl(var(--foreground)/0.06)] backdrop-blur">
      <span className="inline-flex size-7 items-center justify-center rounded-full bg-cobalt font-mono text-[11px] font-semibold text-white" aria-hidden="true">
        {initials}
      </span>
      <span data-testid="user-menu-name" className="hidden max-w-[9rem] truncate px-1.5 text-[13px] font-medium sm:inline">{user?.name}</span>
      <Button size="sm" variant="ghost" className="h-7 rounded-full px-2.5 text-muted-foreground" onClick={() => { signOut(); router.push("/"); }}>
        Sign out
      </Button>
    </span>
  );
}

// Seeded by tests/playwright/ui-demo.ts; the API only accepts test tokens for existing users.
const DEMO_USERS: (AppUser & { tone: string })[] = [
  { id: "demo-ana", name: "Ana Silva", tone: "bg-brand text-brand-foreground" },
  { id: "demo-raj", name: "Raj Patel", tone: "bg-cobalt text-white" },
];

function TestSignIn({ mode }: { mode: "sign-in" | "sign-up" }) {
  const { signIn } = useCtx();
  const router = useRouter();
  const [id, setId] = useState("");
  const go = (u: AppUser) => {
    signIn(u);
    const next = typeof router.query.redirect_url === "string" ? router.query.redirect_url : "/rooms";
    router.push(next.startsWith("/") ? next : "/rooms");
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (id.trim()) go({ id: id.trim(), name: id.trim() });
  };
  const signUp = mode === "sign-up";
  const switchHref = { pathname: signUp ? "/sign-in" : "/sign-up", query: router.query.redirect_url ? { redirect_url: router.query.redirect_url } : {} };

  return (
    <div data-testid="test-sign-in">
      <div>
        <div className="grid gap-2">
          {DEMO_USERS.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => go(u)}
              className="group flex w-full items-center gap-3 rounded-lg border bg-background/60 px-3 py-2.5 text-left transition-[background-color,border-color,transform] duration-200 hover:border-foreground/25 hover:bg-accent active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold ${u.tone}`}>
                {u.name.split(" ").map((p) => p[0]).join("")}
              </span>
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm font-medium">Continue as {u.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{u.id}</span>
              </span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-foreground" />
            </button>
          ))}
        </div>

        <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or use a user ID
          <span className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={submit} className="grid gap-4">
          <Field label="User ID" htmlFor="test-uid">
            <Input id="test-uid" value={id} placeholder="e.g. demo-ana" autoComplete="username" onChange={(e) => setId(e.target.value)} />
          </Field>
          <Button type="submit" variant="brand" size="lg" className="w-full" disabled={!id.trim()}>
            Continue <ArrowRight />
          </Button>
        </form>
      </div>

      <div className="-mx-6 mt-7 border-t bg-muted/40 px-6 py-4 text-center text-sm text-muted-foreground sm:-mx-8">
        {signUp ? "Already have an account? " : "New to codexync? "}
        <Link href={switchHref} className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-brand hover:underline">
          {signUp ? "Sign in" : "Create an account"}
        </Link>
      </div>
      <p className="-mx-6 -mb-6 flex items-center justify-center gap-1.5 border-t px-6 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground sm:-mx-8 sm:-mb-7">
        <FlaskConical className="size-3" aria-hidden="true" />
        Preview build · real sign-in uses Clerk
      </p>
    </div>
  );
}

const SignInView = () => <TestSignIn mode="sign-in" />;
const SignUpView = () => <TestSignIn mode="sign-up" />;
const useSyncUrlOverride = () => useCtx().syncUrl;

const impl: AuthModule = { AuthProvider, useAppAuth, UserMenu, SignInView, SignUpView, useSyncUrlOverride };
export default impl;
