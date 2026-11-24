const path = require("path");

// Test-only pages (src/pages/**/*.e2e.tsx) are compiled ONLY when NEXT_PUBLIC_E2E=1 at
// build time. Regular pages and the middleware use the "page" extension. A production
// build therefore contains no /e2e route and no E2E code at all (tests/test-a4-prod-404.ts).
const E2E_BUILD = process.env.NEXT_PUBLIC_E2E === "1";

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  pageExtensions: ["page.tsx", "page.ts", ...(E2E_BUILD ? ["e2e.tsx"] : [])],
  // E2E builds use a separate output dir so they never overwrite the production build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Optional: fewer build workers on memory-constrained machines (NEXT_BUILD_CPUS=1).
  ...(process.env.NEXT_BUILD_CPUS ? { experimental: { cpus: Number(process.env.NEXT_BUILD_CPUS) } } : {}),
  webpack: (config, { webpack }) => {
    if (E2E_BUILD) {
      // Test builds: swap Clerk auth for the test-token implementation. Production
      // builds never see src/e2e/testAuth.tsx (A4 scans the output for its marker).
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/[\\/]clerkAuth$/, path.resolve(__dirname, "src/e2e/testAuth.tsx"))
      );
    }
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      // y-monaco imports Monaco's ESM API; point it at the single AMD instance the
      // editor loads (see src/lib/monaco-global.js).
      "monaco-editor/esm/vs/editor/editor.api.js$": path.resolve(__dirname, "src/lib/monaco-global.js"),
    };
    return config;
  },
};
