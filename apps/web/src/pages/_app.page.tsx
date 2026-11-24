import type { AppProps } from "next/app";
import Head from "next/head";
import { Toaster } from "sonner";
import { Bricolage_Grotesque, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "../styles/globals.css";
import "@xterm/xterm/css/xterm.css";
import { AuthProvider } from "../lib/auth";
import { AppShell } from "../components/AppShell";
import { TooltipProvider } from "../components/ui/overlay";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700", "800"] });
const sans = IBM_Plex_Sans({ subsets: ["latin"], variable: "--font-sans", weight: ["400", "500", "600"] });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500", "600"] });
// Declared on :root so portals (Radix menus, tooltips, toasts) get the same fonts.
const FONT_CSS = `:root{--font-display:${display.style.fontFamily};--font-sans:${sans.style.fontFamily};--font-mono:${mono.style.fontFamily};}`;

export default function App({ Component, pageProps, router }: AppProps) {
  // The test-only /e2e/* pages bring their own token and layout (and only exist in
  // NEXT_PUBLIC_E2E=1 builds; see src/pages/e2e/editor.e2e.tsx).
  if (router.pathname.startsWith("/e2e/")) return <Component {...pageProps} />;
  return (
    <AuthProvider>
      <Head>
        <title>codexync</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <style jsx global>{`
        ${FONT_CSS}
      `}</style>
      <TooltipProvider delayDuration={250}>
        <AppShell>
          <Component {...pageProps} />
        </AppShell>
        <Toaster position="bottom-right" closeButton toastOptions={{ style: { fontFamily: "var(--font-sans)", borderRadius: "6px" } }} />
      </TooltipProvider>
    </AuthProvider>
  );
}
