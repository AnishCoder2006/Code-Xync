import { execSync } from "child_process";
import fs from "fs";
import path from "path";

/** Kill everything global-setup started (by pid file too, in case globals were lost). */
export default async function globalTeardown() {
  const pids = new Set<number>();
  for (const p of globalThis.__PW_PROCS ?? []) if (p.pid) pids.add(p.pid);
  const pidFile = path.join(__dirname, ".pw-pids");
  if (fs.existsSync(pidFile)) {
    fs.readFileSync(pidFile, "utf8").split("\n").map(Number).filter(Boolean).forEach((p) => pids.add(p));
    fs.unlinkSync(pidFile);
  }
  for (const pid of pids) {
    try {
      if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
    } catch {}
  }
  console.log(`[PW teardown] stopped ${pids.size} processes`);
}
