/**
 * /e2e/editor — test-only page (Week 4 Task 7).
 *
 * BUILD-TIME exclusion: this file's extension is ".e2e.tsx". next.config.js lists
 * "e2e.tsx" in pageExtensions ONLY when NEXT_PUBLIC_E2E=1 at build time, so a normal
 * production build never compiles this file: the route is absent from the build and
 * /e2e/editor is a plain 404. (Every real page is named *.page.tsx for the same reason.)
 * Proof: tests/test-a4-prod-404.ts.
 */
import dynamic from "next/dynamic";

export default dynamic(() => import("../../e2e/E2EEditorPage"), { ssr: false });
