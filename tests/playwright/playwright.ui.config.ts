import { defineConfig } from "@playwright/test";

/**
 * PRODUCT UI suite (plan Part 2): real pages (/rooms, /room/[id]) in Chromium against
 * the full stack, E2E build with test auth, mock LLM. Separate from the /e2e/editor
 * suite (playwright.config.ts) because it also needs the API, AI service and worker.
 *
 *   cd tests/playwright && NODE_ENV=test npx playwright test -c playwright.ui.config.ts
 *
 * retries: 0 so the 3-runs-in-a-row check sees every failure.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "ui-*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/ui-results.json" }]],
  use: {
    headless: true,
    viewport: { width: 1360, height: 820 },
    actionTimeout: 15_000,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  globalSetup: require.resolve("./ui-global-setup"),
  globalTeardown: require.resolve("./ui-global-teardown"),
});
