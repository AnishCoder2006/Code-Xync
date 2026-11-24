import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAppAuth } from "./auth";

/**
 * Client-side guard for protected pages. In production the Clerk middleware already
 * redirects signed-out requests on the server; this covers client navigation and the
 * test build (which has no Clerk middleware).
 */
export function useRequireAuth() {
  const auth = useAppAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.isLoaded && !auth.isSignedIn) {
      router.replace(`/sign-in?redirect_url=${encodeURIComponent(router.asPath)}`);
    }
  }, [auth.isLoaded, auth.isSignedIn, router]);
  return auth;
}
