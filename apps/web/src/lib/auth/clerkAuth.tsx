/**
 * Production auth: Clerk. Swapped for src/e2e/testAuth.tsx in NEXT_PUBLIC_E2E=1 builds
 * (see next.config.js). Everything in the app imports auth from "lib/auth", never Clerk.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { ClerkProvider, SignIn, SignUp, UserButton, useAuth, useUser } from "@clerk/nextjs";
import type { AppAuth, AuthModule } from "./types";

function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      afterSignOutUrl="/"
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/rooms"
      signUpFallbackRedirectUrl="/rooms"
      appearance={{
        // Match the CodeSync palette (globals.css): teal primary, rounded corners.
        variables: { colorPrimary: "hsl(174 72% 32%)", borderRadius: "0.6rem", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
      }}
    >
      {children}
    </ClerkProvider>
  );
}

function useAppAuth(): AppAuth {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const { user } = useUser();
  const appUser = useMemo(() => {
    if (!isSignedIn || !userId) return null;
    const name =
      user?.fullName ||
      user?.username ||
      user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
      "You";
    return { id: userId, name, imageUrl: user?.imageUrl };
  }, [isSignedIn, userId, user]);
  const token = useCallback(() => getToken(), [getToken]);
  return { isLoaded, isSignedIn: !!isSignedIn, user: appUser, getToken: token };
}

function UserMenu() {
  return <UserButton />;
}

function SignInView() {
  return <SignIn path="/sign-in" routing="path" signUpUrl="/sign-up" />;
}

function SignUpView() {
  return <SignUp path="/sign-up" routing="path" signInUrl="/sign-in" />;
}

const useSyncUrlOverride = (): string | undefined => undefined;

const impl: AuthModule = { AuthProvider, useAppAuth, UserMenu, SignInView, SignUpView, useSyncUrlOverride };
export default impl;
