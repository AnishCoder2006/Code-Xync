// Central place for sandbox limit constants (keep in sync with design doc 3.1).
export const SANDBOX_LIMITS = {
  cpus: 0.5,
  memoryMb: 256,
  pidsLimit: 64,
  timeoutMs: 5000,
  maxOutputBytes: 1_000_000,
  tmpfsSizeMb: 16,
};
