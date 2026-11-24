import type { AppProps } from "next/app";
import { ClerkProvider } from "@clerk/nextjs";

export default function App({ Component, pageProps, router }: AppProps) {
  // The test-only /e2e/* pages authenticate with test tokens, not Clerk (and only
  // exist in NEXT_PUBLIC_E2E=1 builds; see src/pages/e2e/editor.tsx).
  if (router.pathname.startsWith("/e2e/")) return <Component {...pageProps} />;
  return (
    <ClerkProvider>
      <Component {...pageProps} />
    </ClerkProvider>
  );
}
