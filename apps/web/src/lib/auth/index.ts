// The app's only auth entry point. `./clerkAuth` is replaced by src/e2e/testAuth.tsx in
// NEXT_PUBLIC_E2E=1 builds (next.config.js); both implement AuthModule.
import impl from "./clerkAuth";

export type { AppAuth, AppUser } from "./types";
export const { AuthProvider, useAppAuth, UserMenu, SignInView, SignUpView, useSyncUrlOverride } = impl;
