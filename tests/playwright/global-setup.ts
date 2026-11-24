/**
 * Global setup for the REAL-BROWSER suite (tests/playwright/browser-*.spec.ts).
 *
 * Starts, as plain processes so tests can kill them:
 *   - the web app: a NEXT_PUBLIC_E2E=1 production build (apps/web/.next-e2e) on :3100
 *   - two sync nodes (:4041, :4042) and the round-robin LB (:4040)
 *   - the API (:4050, NODE_ENV=test) pointed at the LB, for the cross-node Accept test
 *
 * The E2E build is (re)built when apps/web/.next-e2e is missing or E2E_FORCE_BUILD=1.
 * A Clerk publishable key is required to prerender the Clerk-wrapped pages; E2E/CI builds
 * use a syntactically valid placeholder (no real Clerk instance is contacted by /e2e/*).
 */
import { spawn, ChildProcess, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { ROOT, WEB_PORT, PORT_NODE1, PORT_NODE2, LB_PORT, startNode, startLB, wait, INTERNAL_SECRET } from "./helpers";

export const API_PORT = 4050;
export const E2E_PLACEHOLDER_CLERK_PK = "pk_test_" + Buffer.from("e2e-placeholder.clerk.accounts.dev$").toString("base64");
const WEB_DIR = path.join(ROOT, "apps/web");
const E2E_DIST = path.join(WEB_DIR, ".next-e2e");
const NEXT_BIN = path.join(ROOT, "node_modules/next/dist/bin/next");
const TSX_CLI = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");

declare global {
  // eslint-disable-next-line no-var
  var __PW_PROCS: ChildProcess[] | undefined;
}

const webEnv = () => ({
  ...process.env,
  NEXT_PUBLIC_E2E: "1",
  NEXT_DIST_DIR: ".next-e2e",
  NEXT_TELEMETRY_DISABLED: "1",
  // One build worker: a parallel build hit "Fatal process out of memory: Zone" on this
  // machine when the system commit charge was near its limit.
  NEXT_BUILD_CPUS: process.env.NEXT_BUILD_CPUS || "1",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || E2E_PLACEHOLDER_CLERK_PK,
});

async function waitHttp(url: string, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await wait(300);
  }
  throw new Error(`${label} did not come up at ${url}`);
}

export default async function globalSetup() {
  if (!fs.existsSync(path.join(E2E_DIST, "BUILD_ID")) || process.env.E2E_FORCE_BUILD === "1") {
    console.log("[PW setup] Building web app with NEXT_PUBLIC_E2E=1 into apps/web/.next-e2e ...");
    execSync("npm run build", { cwd: WEB_DIR, env: webEnv(), stdio: "inherit" });
  }

  const procs: ChildProcess[] = [];
  globalThis.__PW_PROCS = procs;

  const web = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(WEB_PORT)], {
    cwd: WEB_DIR,
    env: webEnv(),
    stdio: "ignore",
  });
  procs.push(web);

  procs.push(await startNode(PORT_NODE1, "pw-node-01"));
  procs.push(await startNode(PORT_NODE2, "pw-node-02"));
  procs.push((await startLB(LB_PORT, [PORT_NODE1, PORT_NODE2])).proc);

  const api = spawn(process.execPath, [TSX_CLI, path.join(ROOT, "services/api/src/index.ts")], {
    cwd: path.join(ROOT, "services/api"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      API_PORT: String(API_PORT),
      SYNC_SERVICE_URL: `http://127.0.0.1:${LB_PORT}`,
      INTERNAL_API_SECRET: INTERNAL_SECRET,
    },
    stdio: "ignore",
  });
  procs.push(api);

  await waitHttp(`http://127.0.0.1:${WEB_PORT}/e2e/editor?room=x&uid=y`, "web (E2E build)");
  const probe = await fetch(`http://127.0.0.1:${WEB_PORT}/e2e/editor?room=x&uid=y`);
  if (probe.status !== 200) throw new Error(`/e2e/editor returned ${probe.status}: the running build is not an E2E build`);
  await waitHttp(`http://127.0.0.1:${LB_PORT}/health`, "sync LB");
  await waitHttp(`http://127.0.0.1:${API_PORT}/health`, "api");
  fs.writeFileSync(path.join(__dirname, ".pw-pids"), procs.map((p) => p.pid).join("\n"));
  console.log(`[PW setup] web :${WEB_PORT}, sync :${PORT_NODE1}/:${PORT_NODE2}, LB :${LB_PORT}, api :${API_PORT} ready`);
}
