import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher(["/", "/benchmarks", "/sign-in(.*)", "/sign-up(.*)"]);

// NEXT_PUBLIC_E2E is inlined at build time. Test builds authenticate with test tokens
// (src/e2e/testAuth.tsx) and guard pages on the client, so they skip Clerk entirely.
// Production builds: signed-out requests to any non-public page redirect to /sign-in.
export default process.env.NEXT_PUBLIC_E2E === "1"
  ? () => NextResponse.next()
  : clerkMiddleware(async (auth, request) => {
      if (!isPublicRoute(request)) await auth.protect();
    });

export const config = {
  matcher: [
    // Skip Next.js internals, all static files (unless found in search params), the
    // self-hosted Monaco files, and /e2e/* (test-only pages that use test tokens; in a
    // production build they do not exist and return 404 — they must not redirect to
    // sign-in instead).
    "/((?!_next|monaco/|e2e/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
