import { execSync } from "child_process";

export default async function globalTeardown() {
  console.log("[PW Teardown] Cleaning up sync nodes and LB...");
  if (globalThis.__PW_PROCS) {
    for (const p of globalThis.__PW_PROCS) {
      if (p && p.pid) {
        try {
          if (process.platform === "win32") {
            execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: "ignore" });
          } else {
            p.kill("SIGKILL");
          }
        } catch {}
      }
    }
  }
}

