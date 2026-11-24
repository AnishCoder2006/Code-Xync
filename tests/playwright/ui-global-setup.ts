/**
 * Global setup for the PRODUCT UI suite (tests/playwright/ui-*.spec.ts, plan Part 2).
 *
 * Starts the whole stack as plain processes, all NODE_ENV=test, test tokens, mock LLM:
 *   web   :3100  NEXT_PUBLIC_E2E=1 build (test auth swapped in at build time)
 *   sync  :4041 + :4042 behind the round-robin LB :4040
 *   api   :4050  CORS for the web origin; AI -> :4051; sync -> LB
 *   ai    :4051  uvicorn, LLM_PROVIDER=mock_scenario, sandbox via the API
 *   worker       hardened Docker sandbox (needs Docker + codesync-sandbox-* images)
 */
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { ROOT, WEB_PORT, PORT_NODE1, PORT_NODE2, LB_PORT, INTERNAL_SECRET, startNode, startLB } from "./helpers";
import { API_PORT, NEXT_BIN, TSX_CLI, WEB_DIR, ensureE2EBuild, waitHttp, webEnv } from "./global-setup";

export const AI_PORT = 4051;
export const UI_PID_FILE = path.join(__dirname, ".pw-ui-pids");
const PYTHON = path.join(ROOT, process.platform === "win32" ? "services/ai/.venv/Scripts/python.exe" : "services/ai/.venv/bin/python");
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6380";
const LOG_DIR = path.join(__dirname, "test-results", "ui-logs");

declare global {
  // eslint-disable-next-line no-var
  var __PW_UI_PROCS: ChildProcess[] | undefined;
}

function logTo(proc: ChildProcess, name: string) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.createWriteStream(path.join(LOG_DIR, `${name}.log`));
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  return proc;
}

function waitForLine(proc: ChildProcess, needle: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for "${needle}"`)), ms);
    const on = (d: Buffer) => {
      if (d.toString().includes(needle)) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout?.on("data", on);
    proc.stderr?.on("data", on);
  });
}

export default async function uiGlobalSetup() {
  ensureE2EBuild();
  const procs: ChildProcess[] = [];
  globalThis.__PW_UI_PROCS = procs;
  const save = () => fs.writeFileSync(UI_PID_FILE, procs.map((p) => p.pid).join("\n"));

  procs.push(logTo(spawn(process.execPath, [NEXT_BIN, "start", "-p", String(WEB_PORT)], { cwd: WEB_DIR, env: webEnv(), stdio: ["ignore", "pipe", "pipe"] }), "web"));
  save();
  procs.push(await startNode(PORT_NODE1, "pw-node-01"));
  procs.push(await startNode(PORT_NODE2, "pw-node-02"));
  procs.push((await startLB(LB_PORT, [PORT_NODE1, PORT_NODE2])).proc);
  save();

  const webOrigins = [`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`].join(",");
  procs.push(
    logTo(
      spawn(process.execPath, [TSX_CLI, path.join(ROOT, "services/api/src/index.ts")], {
        cwd: path.join(ROOT, "services/api"),
        env: {
          ...process.env,
          NODE_ENV: "test",
          API_PORT: String(API_PORT),
          SYNC_SERVICE_URL: `http://127.0.0.1:${LB_PORT}`,
          AI_SERVICE_URL: `http://127.0.0.1:${AI_PORT}`,
          INTERNAL_API_SECRET: INTERNAL_SECRET,
          CORS_ORIGINS: webOrigins,
          REDIS_URL,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      "api"
    )
  );
  save();

  procs.push(
    logTo(
      spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(AI_PORT)], {
        cwd: path.join(ROOT, "services/ai"),
        env: {
          ...process.env,
          LLM_PROVIDER: "mock_scenario",
          SANDBOX_URL: `http://127.0.0.1:${API_PORT}/execution/sandbox`,
          INTERNAL_API_SECRET: INTERNAL_SECRET,
          REDIS_URL,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      "ai"
    )
  );
  save();

  const worker = logTo(
    spawn(process.execPath, [TSX_CLI, path.join(ROOT, "services/worker/src/index.ts")], {
      cwd: path.join(ROOT, "services/worker"),
      env: { ...process.env, NODE_ENV: "test", REDIS_URL, WORKER_CONCURRENCY: "2" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "worker"
  );
  procs.push(worker);
  save();

  await waitForLine(worker, "Execution Worker started", 60_000);
  await waitHttp(`http://127.0.0.1:${WEB_PORT}/`, "web (E2E build)");
  await waitHttp(`http://127.0.0.1:${LB_PORT}/health`, "sync LB");
  await waitHttp(`http://127.0.0.1:${API_PORT}/health`, "api");
  await waitHttp(`http://127.0.0.1:${AI_PORT}/health`, "ai", 90_000);
  console.log(`[UI setup] web :${WEB_PORT}, sync :${PORT_NODE1}/:${PORT_NODE2} via LB :${LB_PORT}, api :${API_PORT}, ai :${AI_PORT}, worker ready`);
}
