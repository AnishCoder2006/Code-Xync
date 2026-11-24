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
import { useRouter } from "next/router";
import type { AppAuth, AppUser, AuthModule } from "../lib/auth/types";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/display";

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
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span data-testid="user-menu-name" className="text-muted-foreground">{user?.name}</span>
      <Button size="sm" variant="ghost" onClick={() => { signOut(); router.push("/"); }}>Sign out</Button>
    </span>
  );
}

function TestSignIn({ title }: { title: string }) {
  const { signIn } = useCtx();
  const router = useRouter();
  const [id, setId] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!id.trim()) return;
    signIn({ id: id.trim(), name: id.trim() });
    const next = typeof router.query.redirect_url === "string" ? router.query.redirect_url : "/rooms";
    router.push(next.startsWith("/") ? next : "/rooms");
  };
  return (
    <Card className="w-full max-w-sm" data-testid="test-sign-in">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Test build: sign in as an existing user ID.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="User ID" htmlFor="test-uid">
            <Input id="test-uid" value={id} onChange={(e) => setId(e.target.value)} />
          </Field>
          <Button type="submit">Continue</Button>
        </form>
      </CardContent>
    </Card>
  );
}

const SignInView = () => <TestSignIn title="Sign in" />;
const SignUpView = () => <TestSignIn title="Sign up" />;
const useSyncUrlOverride = () => useCtx().syncUrl;

const impl: AuthModule = { AuthProvider, useAppAuth, UserMenu, SignInView, SignUpView, useSyncUrlOverride };
export default impl;
