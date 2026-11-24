/**
 * Production auth: Clerk. Swapped for src/e2e/testAuth.tsx in NEXT_PUBLIC_E2E=1 builds
 * (see next.config.js). Everything in the app imports auth from "lib/auth", never Clerk.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { ClerkProvider, SignIn, SignUp, UserButton, useAuth, useUser } from "@clerk/nextjs";
import type { AppAuth, AuthModule } from "./types";
import { useColorScheme } from "../util";

// Clerk derives shades from these, so they must be literal colours (mirrors globals.css).
const CLERK_COLORS = {
  light: {
    colorPrimary: "#c2410c",
    colorTextOnPrimaryBackground: "#ffffff",
    colorBackground: "#fbfaf6",
    colorText: "#161513",
    colorTextSecondary: "#5c574d",
    colorInputBackground: "#ffffff",
    colorInputText: "#161513",
    colorNeutral: "#161513",
  },
  dark: {
    colorPrimary: "#f05a26",
    colorTextOnPrimaryBackground: "#141210",
    colorBackground: "#232120",
    colorText: "#ede9e1",
    colorTextSecondary: "#b4aea3",
    colorInputBackground: "#1c1a17",
    colorInputText: "#ede9e1",
    colorNeutral: "#ede9e1",
  },
} as const;

function AuthProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  return (
    <ClerkProvider
      afterSignOutUrl="/"
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/rooms"
      signUpFallbackRedirectUrl="/rooms"
      appearance={{
        layout: { socialButtonsPlacement: "top", socialButtonsVariant: "blockButton", logoPlacement: "none" },
        variables: {
          ...CLERK_COLORS[scheme],
          borderRadius: "0.5rem",
          fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
          fontSize: "0.9375rem",
        },
        elements: {
          rootBox: "w-full",
          cardBox: "w-full max-w-none rounded-xl border border-border shadow-[0_30px_60px_-30px_rgba(0,0,0,0.45)]",
          headerTitle: "font-display text-2xl tracking-tight",
          formButtonPrimary: "font-semibold normal-case shadow-none",
          footerActionLink: "font-semibold",
        },
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
