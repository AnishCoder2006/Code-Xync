import type { ReactNode } from "react";

export type AppUser = { id: string; name: string; imageUrl?: string };

export type AppAuth = {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AppUser | null;
  /** Bearer token for the API and the sync WebSocket (fresh on every call). */
  getToken: () => Promise<string | null>;
};

/**
 * What every auth implementation exports. The production one is clerkAuth.tsx (Clerk);
 * NEXT_PUBLIC_E2E=1 builds swap it for src/e2e/testAuth.tsx at build time
 * (NormalModuleReplacementPlugin in next.config.js), so test-token code never ships.
 */
export type AuthModule = {
  AuthProvider: (props: { children: ReactNode }) => JSX.Element;
  useAppAuth: () => AppAuth;
  UserMenu: () => JSX.Element;
  SignInView: () => JSX.Element;
  SignUpView: () => JSX.Element;
  /** Test builds only: pin the sync WebSocket to one node. Always undefined in production. */
  useSyncUrlOverride: () => string | undefined;
};
