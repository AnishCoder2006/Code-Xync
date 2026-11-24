/**
 * Production auth: Clerk. Swapped for src/e2e/testAuth.tsx in NEXT_PUBLIC_E2E=1 builds
 * (see next.config.js). Everything in the app imports auth from "lib/auth", never Clerk.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { ClerkProvider, SignIn, SignUp, UserButton, useAuth, useUser } from "@clerk/nextjs";
import type { AppAuth, AuthModule } from "./types";
import { useColorScheme } from "../util";
import { clerkAuthAppearance, clerkProviderVariables } from "./clerkAppearance";

// Social buttons show just the provider name so Google and GitHub fit side by side.
const LOCALIZATION = {
  socialButtonsBlockButton: "{{provider|titleize}}",
  socialButtonsBlockButtonManyInView: "{{provider|titleize}}",
};

function AuthProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  return (
    <ClerkProvider
      afterSignOutUrl="/"
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/rooms"
      signUpFallbackRedirectUrl="/rooms"
      localization={LOCALIZATION}
      appearance={{ variables: clerkProviderVariables(scheme) }}
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
  const scheme = useColorScheme();
  return <SignIn path="/sign-in" routing="path" signUpUrl="/sign-up" appearance={clerkAuthAppearance(scheme)} />;
}

function SignUpView() {
  const scheme = useColorScheme();
  return <SignUp path="/sign-up" routing="path" signInUrl="/sign-in" appearance={clerkAuthAppearance(scheme)} />;
}

const useSyncUrlOverride = (): string | undefined => undefined;

const impl: AuthModule = { AuthProvider, useAppAuth, UserMenu, SignInView, SignUpView, useSyncUrlOverride };
export default impl;
