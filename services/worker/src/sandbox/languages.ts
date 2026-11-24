/**
 * Runnable languages: image, file name and interpreter for each. Every image runs with
 * the SAME hardening flags (hardening.ts): no network, read-only root, noexec /tmp,
 * non-root, all caps dropped, memory/CPU/pids limits. Only interpreted languages (and
 * Java's in-memory single-file launch) are here, so nothing is ever executed from disk.
 *
 * Keep the ids in sync with apps/web/src/lib/languages.ts, services/api/src/lib/languages.ts
 * and services/ai/app/agent/languages.py (tests/test-languages.ts checks they agree).
 */
export type RunSpec = {
  image: string;
  /** File name inside /app (interactive runs mount the code there). */
  file: string;
  /** Interpreter argv; the file path is appended. argv[0] becomes the container entrypoint. */
  argv: string[];
  /** Executables a snapshot (AI test) command may start with for this language. */
  runners: string[];
  /** Override of SANDBOX_LIMITS.timeoutMs (container start included). */
  timeoutMs?: number;
};

export const RUNNERS: Record<string, RunSpec> = {
  python: { image: "codesync-sandbox-python", file: "main.py", argv: ["python3"], runners: ["python3", "python"] },
  javascript: { image: "codesync-sandbox-node", file: "index.js", argv: ["node"], runners: ["node"] },
  typescript: {
    image: "codesync-sandbox-typescript",
    file: "main.ts",
    argv: ["node", "--experimental-transform-types", "--no-warnings"],
    runners: ["node"],
  },
  ruby: { image: "codesync-sandbox-ruby", file: "main.rb", argv: ["ruby"], runners: ["ruby"] },
  // display_errors=stderr: PHP prints fatal errors to stdout by default; send them to stderr.
  php: { image: "codesync-sandbox-php", file: "main.php", argv: ["php", "-d", "display_errors=stderr"], runners: ["php"] },
  perl: { image: "codesync-sandbox-scripts", file: "main.pl", argv: ["perl"], runners: ["perl"] },
  lua: { image: "codesync-sandbox-scripts", file: "main.lua", argv: ["lua5.4"], runners: ["lua5.4", "lua"] },
  bash: { image: "codesync-sandbox-scripts", file: "main.sh", argv: ["bash"], runners: ["bash", "sh"] },
  java: {
    image: "codesync-sandbox-java",
    file: "Main.java",
    // Single-file source launch compiles in memory. Small heap + C1 only + serial GC keep
    // it inside 256 MB / 64 pids; compiling makes it slower to start than the others.
    argv: ["java", "-Xmx128m", "-Xss512k", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-XX:CICompilerCount=1", "-Xshare:auto"],
    runners: ["java"],
    timeoutMs: 15000,
  },
};

// Older callers used "sh" for bash.
const ALIASES: Record<string, string> = { sh: "bash", py: "python", js: "javascript", ts: "typescript" };

export function runSpecFor(language: string): RunSpec | null {
  const id = ALIASES[language] ?? language;
  return RUNNERS[id] ?? null;
}
