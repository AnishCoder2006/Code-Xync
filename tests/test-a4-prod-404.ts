/**
 * A4: a production build (NEXT_PUBLIC_E2E unset) has no /e2e/editor.
 *
 *   npx tsx tests/test-a4-prod-404.ts
 *
 * 1. `next build` with NEXT_PUBLIC_E2E unset into apps/web/.next (the normal output dir).
 * 2. Build-time check: no file in the build output contains the E2E page's code
 *    (the "test-token-" string or the E2EEditorPage component).
 * 3. `next start`: GET /e2e/editor -> 404 (not 200, not a sign-in redirect).
 * 4. Restart the SAME build with NEXT_PUBLIC_E2E=1 in the runtime env: still 404,
 *    because the guard is resolved at build time.
 *
 * Clerk-wrapped pages need a publishable key to prerender; a syntactically valid
 * placeholder is used when none is set (no Clerk instance is contacted by this test).
 */
import { spawn, ChildProcess, execSync } from "child_process";
import fs from "fs";
import path from "path";

const WEB_DIR = path.resolve(__dirname, "../apps/web");
const DIST = path.join(WEB_DIR, ".next");
const NEXT_BIN = path.resolve(__dirname, "../node_modules/next/dist/bin/next");
const PORT = 3009;
const PLACEHOLDER_PK = "pk_test_" + Buffer.from("e2e-placeholder.clerk.accounts.dev$").toString("base64");

function killProc(proc: ChildProcess | null) {
  if (!proc?.pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    else proc.kill("SIGKILL");
  } catch {}
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "cache") continue; // webpack cache, not served output
      out.push(...filesUnder(p));
    } else if (/\.(js|json|html|txt)$/.test(e.name)) out.push(p);
  }
  return out;
}

async function startAndGet(env: NodeJS.ProcessEnv, label: string): Promise<number> {
  const proc = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(PORT)], { cwd: WEB_DIR, env, stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const res = await fetch(`http://127.0.0.1:${PORT}/e2e/editor?room=r&uid=u`, { redirect: "manual" });
    console.log(`   [${label}] GET /e2e/editor -> ${res.status} ${res.statusText}${res.headers.get("location") ? " location=" + res.headers.get("location") : ""}`);
    return res.status;
  } finally {
    killProc(proc);
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function main() {
  console.log("=========================================================================");
  console.log("   A4: production build (NEXT_PUBLIC_E2E unset) must 404 on /e2e/editor ");
  console.log("=========================================================================\n");

  const env: NodeJS.ProcessEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.NEXT_PUBLIC_E2E;
  delete env.NEXT_DIST_DIR;
  env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || PLACEHOLDER_PK;
  console.log(`   NEXT_PUBLIC_E2E in build env: ${JSON.stringify(env.NEXT_PUBLIC_E2E)}`);

  execSync("npm run build", { cwd: WEB_DIR, env, stdio: "inherit" });

  const offenders = filesUnder(DIST).filter((f) => {
    const s = fs.readFileSync(f, "utf8");
    return s.includes("test-token-") || s.includes("E2EEditorPage") || s.includes("e2e-connects");
  });
  console.log(`\n   Build-time check: scanned ${filesUnder(DIST).length} output files in apps/web/.next (excluding cache/)`);
  console.log(`   Files containing E2E page code ("test-token-", "E2EEditorPage", "e2e-connects"): ${offenders.length}`);
  offenders.forEach((f) => console.log("     - " + path.relative(WEB_DIR, f)));

  const statusProd = await startAndGet(env, "prod build, NEXT_PUBLIC_E2E unset");
  const statusRuntimeFlag = await startAndGet({ ...env, NEXT_PUBLIC_E2E: "1" }, "same build, NEXT_PUBLIC_E2E=1 at runtime only");

  const checks: Array<[boolean, string]> = [
    [offenders.length === 0, "no E2E page code in the production build output"],
    [statusProd === 404, "/e2e/editor returns 404 on the production build"],
    [statusRuntimeFlag === 404, "setting NEXT_PUBLIC_E2E=1 at runtime does not enable it (build-time guard)"],
  ];
  console.log("");
  for (const [ok, label] of checks) console.log(`   ${ok ? "PASS" : "FAIL"}: ${label}`);
  if (checks.some(([ok]) => !ok)) throw new Error("A4 checks failed");
  console.log("\n   -> PASS: Task A4 verified");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("TEST FAILED:", err.message ?? err);
    process.exit(1);
  });
