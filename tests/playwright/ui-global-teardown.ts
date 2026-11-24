import { execSync } from "child_process";
import fs from "fs";
import { UI_PID_FILE } from "./ui-global-setup";

/** Kill everything ui-global-setup started (also by pid file, in case globals were lost). */
export default async function uiGlobalTeardown() {
  const pids = new Set<number>();
  for (const p of globalThis.__PW_UI_PROCS ?? []) if (p.pid) pids.add(p.pid);
  if (fs.existsSync(UI_PID_FILE)) {
    fs.readFileSync(UI_PID_FILE, "utf8").split("\n").map(Number).filter(Boolean).forEach((p) => pids.add(p));
    fs.unlinkSync(UI_PID_FILE);
  }
  for (const pid of pids) {
    try {
      if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
    } catch {}
  }
  console.log(`[UI teardown] stopped ${pids.size} processes`);
}
