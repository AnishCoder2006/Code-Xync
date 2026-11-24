import type { AppProps } from "next/app";
import Head from "next/head";
import { Toaster } from "sonner";
import "../styles/globals.css";
import "@xterm/xterm/css/xterm.css";
import { AuthProvider } from "../lib/auth";
import { AppShell } from "../components/AppShell";
import { TooltipProvider } from "../components/ui/overlay";

export default function App({ Component, pageProps, router }: AppProps) {
  // The test-only /e2e/* pages bring their own token and layout (and only exist in
  // NEXT_PUBLIC_E2E=1 builds; see src/pages/e2e/editor.e2e.tsx).
  if (router.pathname.startsWith("/e2e/")) return <Component {...pageProps} />;
  return (
    <AuthProvider>
      <Head>
        <title>CodeSync</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <TooltipProvider delayDuration={250}>
        <AppShell>
          <Component {...pageProps} />
        </AppShell>
        <Toaster position="bottom-right" richColors closeButton />
      </TooltipProvider>
    </AuthProvider>
  );
}
