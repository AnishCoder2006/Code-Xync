/**
 * Phase 6 B7 / plan §3.3: pre-started, SINGLE-USE sandbox containers ("warm pool").
 *
 * Containers cannot get a volume after creation, so the job's code is piped over stdin
 * (plan §3.3). Each pooled container is a normal `docker run -i --rm` with exactly the
 * same hardening flags as a fresh job container (hardening.ts) whose process is a tiny
 * bootstrap that waits for the program on stdin:
 *   node   : read stdin -> write /tmp/index.js (tmpfs, size-capped) -> require() it
 *   python : read stdin -> exec(compile(src, "/app/main.py", "exec")) as __main__
 * The bootstrap prints one READY line on stderr once the runtime is up; only READY
 * containers are claimed.
 *
 * Single use, never reused: a claimed container runs exactly one job, its process exits,
 * `--rm` deletes it, and the pool starts a NEW container to replace it. A container is
 * never returned to the pool.
 *
 * Scope: interactive single-file node/python jobs. Snapshot (AI test) jobs need several
 * files mounted read-only at /app and bash jobs use another entrypoint; both keep the
 * fresh-container path.
 *
 * Enabled with SANDBOX_WARM_POOL_SIZE=<n per language> (default 0 = disabled).
 */
import { spawn, ChildProcess, execFile } from "child_process";
import { randomUUID } from "crypto";
import { hardeningArgs } from "./hardening";

export type WarmLanguage = "javascript" | "python";

export const READY_MARKER = "__CODESYNC_WARM_READY__";

const NODE_BOOTSTRAP =
  "const fs=require('fs');let s='';process.stdin.setEncoding('utf8');" +
  `process.stderr.write('${READY_MARKER}\\n');` +
  "process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{fs.writeFileSync('/tmp/index.js',s);require('/tmp/index.js');});";

const PY_BOOTSTRAP =
  "import sys\n" +
  `sys.stderr.write('${READY_MARKER}\\n'); sys.stderr.flush()\n` +
  "src = sys.stdin.read()\n" +
  "g = {'__name__': '__main__', '__file__': '/app/main.py'}\n" +
  "exec(compile(src, '/app/main.py', 'exec'), g)\n";

export interface WarmContainer {
  name: string;
  child: ChildProcess;
  language: WarmLanguage;
  spawnedAt: number;
  readyAt: number;
}

interface Pending {
  name: string;
  child: ChildProcess;
  spawnedAt: number;
}

export class WarmPool {
  private ready: Record<WarmLanguage, WarmContainer[]> = { javascript: [], python: [] };
  private starting: Record<WarmLanguage, number> = { javascript: 0, python: 0 };
  private stopped = false;
  readonly stats = { started: 0, claimed: 0, misses: 0, failedToStart: 0 };

  constructor(private readonly sizePerLanguage: number) {}

  get enabled() {
    return this.sizePerLanguage > 0;
  }

  start() {
    if (!this.enabled) return;
    (["javascript", "python"] as WarmLanguage[]).forEach((l) => this.refill(l));
  }

  private refill(language: WarmLanguage) {
    if (this.stopped) return;
    while (this.ready[language].length + this.starting[language] < this.sizePerLanguage) {
      this.starting[language]++;
      this.spawnOne(language)
        .then((c) => {
          if (this.stopped) {
            this.destroy(c.name, c.child);
            return;
          }
          this.ready[language].push(c);
        })
        .catch(() => {
          this.stats.failedToStart++;
        })
        .finally(() => {
          this.starting[language]--;
          // Retry slowly after failures; refill immediately otherwise.
          setTimeout(() => this.refill(language), this.stats.failedToStart > 0 ? 1000 : 0);
        });
    }
  }

  private spawnOne(language: WarmLanguage): Promise<WarmContainer> {
    const name = `codesync-warm-${randomUUID()}`;
    const image = language === "python" ? "codesync-sandbox-python" : "codesync-sandbox-node";
    const args =
      language === "python"
        ? ["run", "-i", "--name", name, "--rm", ...hardeningArgs(), "--entrypoint", "python3", image, "-u", "-c", PY_BOOTSTRAP]
        : ["run", "-i", "--name", name, "--rm", ...hardeningArgs(), "--entrypoint", "node", image, "-e", NODE_BOOTSTRAP];
    const spawnedAt = Date.now();
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.stats.started++;
    const p: Pending = { name, child, spawnedAt };
    return new Promise((resolve, reject) => {
      let buf = "";
      const onErr = (d: Buffer) => {
        buf += d.toString();
        if (buf.includes(READY_MARKER)) {
          child.stderr?.off("data", onErr);
          child.off("exit", onExit);
          resolve({ name, child, language, spawnedAt, readyAt: Date.now() });
        }
      };
      const onExit = () => reject(new Error(`warm container ${p.name} exited before READY: ${buf.slice(0, 200)}`));
      child.stderr?.on("data", onErr);
      child.once("exit", onExit);
      child.once("error", reject);
      setTimeout(() => reject(new Error(`warm container ${name} not READY in 60s`)), 60_000).unref();
    });
  }

  /**
   * Take a ready container for exactly one job, or null on a miss (pool empty / disabled).
   * The caller owns the container from here: it pipes the program to stdin and ends it.
   */
  claim(language: string): WarmContainer | null {
    if (!this.enabled || (language !== "javascript" && language !== "python")) return null;
    const lang = language as WarmLanguage;
    // Drop containers that died while idle.
    this.ready[lang] = this.ready[lang].filter((c) => c.child.exitCode === null && !c.child.killed);
    const c = this.ready[lang].shift() ?? null;
    if (c) this.stats.claimed++;
    else this.stats.misses++;
    this.refill(lang); // replace it with a NEW container (single use)
    return c;
  }

  readyCount(language: WarmLanguage) {
    return this.ready[language].length;
  }

  private destroy(name: string, child: ChildProcess) {
    try {
      child.kill();
    } catch {}
    execFile("docker", ["rm", "-f", name], () => {});
  }

  stop() {
    this.stopped = true;
    for (const l of ["javascript", "python"] as WarmLanguage[]) {
      this.ready[l].forEach((c) => this.destroy(c.name, c.child));
      this.ready[l] = [];
    }
  }
}

export const warmPool = new WarmPool(Number(process.env.SANDBOX_WARM_POOL_SIZE || 0));
