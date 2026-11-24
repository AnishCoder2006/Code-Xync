/**
 * The ONE place the sandbox `docker run` hardening flags are built. Both the fresh
 * per-job container path (dockerRunner.ts) and the warm pool (warmPool.ts) use this
 * function, so the two paths cannot drift apart. Values come from limits.ts.
 */
import { SANDBOX_LIMITS } from "./limits";

export function hardeningArgs(): string[] {
  return [
    "--network", "none",
    "--read-only",
    "--tmpfs", `/tmp:rw,size=${SANDBOX_LIMITS.tmpfsSizeMb}m,noexec,nosuid`,
    "--user", SANDBOX_LIMITS.user,
    "--cap-drop", SANDBOX_LIMITS.capDrop,
    "--security-opt", SANDBOX_LIMITS.securityOpt,
    "--memory", `${SANDBOX_LIMITS.memoryMb}m`,
    "--memory-swap", `${SANDBOX_LIMITS.memoryMb}m`,
    "--cpus", `${SANDBOX_LIMITS.cpus}`,
    "--pids-limit", `${SANDBOX_LIMITS.pidsLimit}`,
  ];
}
