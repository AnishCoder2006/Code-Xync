import { defineConfig } from "@playwright/test";

/**
 * REAL-BROWSER suite: Chromium contexts driving /e2e/editor (Monaco + y-monaco).
 * The websocket-only protocol specs live in tests/sync-protocol (they are not browser tests).
 *
 * retries: 0 on purpose — the 3-runs-in-a-row flakiness check must see every failure.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "browser-*.spec.ts",
  timeout: 150_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1, // serial: tests share the sync cluster and some kill nodes
  reporter: [["list"], ["json", { outputFile: "test-results/browser-results.json" }]],
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 15_000,
    browserName: "chromium",
  },
  globalSetup: require.resolve("./global-setup"),
  globalTeardown: require.resolve("./global-teardown"),
});
