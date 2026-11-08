import { spawn, execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import Redis from "ioredis";
import { SANDBOX_LIMITS } from "./limits";
import { prisma } from "../lib/prisma";

const execFileAsync = promisify(execFile);

export interface ExecutionResult {
  status: "passed" | "failed" | "timeout" | "killed" | "truncated";
  code: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  runTimeMs: number;
  stdoutTrunc: string;
  stderrTrunc: string;
}

export interface SnapshotOptions {
  files?: Record<string, string>;
  command?: string[];
  isSnapshot?: boolean;
}

export const runInDocker = async (
  jobId: string,
  roomId: string,
  code: string,
  language: string,
  redis: Redis,
  snapshotOptions?: SnapshotOptions
): Promise<ExecutionResult> => {
  const containerName = `codesync-job-${jobId}`;
  const channel = `room:${roomId}:execution:${jobId}`;
  const readyKey = `execution:ready:${jobId}`;
  const startedKey = `execution:started:${jobId}`;

  // Clean up any leftover container before starting (e.g. from crash or retry)
  try {
    await execFileAsync("docker", ["rm", "-f", containerName]);
  } catch {
    // Ignore error if container doesn't exist
  }

  // Set up temp directory
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `job-${jobId}-`));
  const isPython = language === "python";
  const isBash = language === "bash" || language === "sh";
  const isSnapshot = !!(snapshotOptions?.isSnapshot || snapshotOptions?.files);

  if (isSnapshot && snapshotOptions?.files) {
    for (const [relPath, content] of Object.entries(snapshotOptions.files)) {
      const fullPath = path.join(tmpDir, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }
  } else {
    const filename = isPython ? "main.py" : isBash ? "script.sh" : "index.js";
    const filePath = path.join(tmpDir, filename);
    await fs.writeFile(filePath, code);
  }

  let timeoutTimer: NodeJS.Timeout | null = null;

  try {
    // Only wait for ready signal on interactive jobs (skip for snapshot / AI jobs)
    if (!isSnapshot) {
      const readyResult = await redis.blpop(readyKey, 5);
      if (!readyResult) {
        console.warn(`[worker] job ${jobId}: no ready signal in 5s, proceeding anyway`);
      }
    }

    // Idempotency check: only publish "start" if this job hasn't already started
    const alreadyStarted = await redis.get(startedKey);
    if (!alreadyStarted) {
      await redis.set(startedKey, "1", "EX", 300);
      await redis.publish(channel, JSON.stringify({ type: "start", jobId }));
    }

    // Update ExecutionLog status to "running" in DB
    await prisma.executionLog
      .updateMany({
        where: { jobId },
        data: { status: "running" },
      })
      .catch((e) => console.warn(`[worker] Failed to set status running for job ${jobId}:`, e));

    const image = isPython || isBash ? "codesync-sandbox-python" : "codesync-sandbox-node";

    // Docker run flags constructed from SANDBOX_LIMITS
    const dockerArgs = [
      "run",
      "--name", containerName,
      "--rm",
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

    if (isSnapshot) {
      dockerArgs.push("-v", `${tmpDir}:/app:ro`);
      dockerArgs.push("-w", "/app");

      const cmd = snapshotOptions?.command && snapshotOptions.command.length > 0
        ? snapshotOptions.command
        : isPython ? ["python3", "main.py"] : ["node", "index.js"];

      if (isPython) {
        dockerArgs.push("--entrypoint", "python3");
        dockerArgs.push(image);
        const args = (cmd[0] === "python" || cmd[0] === "python3") ? cmd.slice(1) : cmd;
        dockerArgs.push(...args);
      } else if (isBash) {
        dockerArgs.push("--entrypoint", "/bin/bash");
        dockerArgs.push(image);
        dockerArgs.push(...cmd);
      } else {
        dockerArgs.push("--entrypoint", "node");
        dockerArgs.push(image);
        const args = cmd[0] === "node" ? cmd.slice(1) : cmd;
        dockerArgs.push(...args);
      }
    } else {
      const filename = isPython ? "main.py" : isBash ? "script.sh" : "index.js";
      const filePath = path.join(tmpDir, filename);
      dockerArgs.push("-v", `${filePath}:/app/${filename}:ro`);
      if (isBash) {
        dockerArgs.push("--entrypoint", "/bin/bash");
      }
      dockerArgs.push(image, `/app/${filename}`);
    }

    return await new Promise<ExecutionResult>((resolve, reject) => {
      let isDone = false;
      let isTimedOut = false;
      let isTruncated = false;
      let totalBytesStreamed = 0;
      let stdoutAccum = "";
      let stderrAccum = "";
      const maxDbChars = SANDBOX_LIMITS.maxDbLogChars;

      const startTime = Date.now();
      const child = spawn("docker", dockerArgs);

      child.on("error", (err) => {
        if (isDone) return;
        isDone = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        reject(err);
      });

      // ── Hard timeout from limits.ts ──
      timeoutTimer = setTimeout(async () => {
        if (isDone) return;
        isTimedOut = true;
        isDone = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }

        // Force-kill container immediately
        execFile("docker", ["rm", "-f", containerName], () => {});
        child.kill("SIGKILL");

        const timeoutMsg = `\nExecution timed out after ${SANDBOX_LIMITS.timeoutMs / 1000}s.\n`;
        if (stderrAccum.length < maxDbChars) {
          stderrAccum += timeoutMsg.slice(0, maxDbChars - stderrAccum.length);
        }
        await redis.publish(channel, JSON.stringify({ type: "stderr", data: timeoutMsg }));
        await redis.publish(channel, JSON.stringify({ type: "end", status: "timeout", code: 124 }));

        const runTimeMs = Date.now() - startTime;
        await prisma.executionLog
          .updateMany({
            where: { jobId },
            data: {
              status: "timeout",
              runTimeMs,
              stdoutTrunc: stdoutAccum,
              stderrTrunc: stderrAccum,
            },
          })
          .catch((e) => console.warn(`[worker] DB update error on timeout for ${jobId}:`, e));

        const timeoutResult: ExecutionResult = {
          status: "timeout",
          code: 124,
          exitCode: 124,
          stdout: stdoutAccum,
          stderr: stderrAccum,
          runTimeMs,
          stdoutTrunc: stdoutAccum,
          stderrTrunc: stderrAccum,
        };
        await redis.set(`execution:result:${jobId}`, JSON.stringify(timeoutResult), "EX", 300);
        resolve(timeoutResult);
      }, SANDBOX_LIMITS.timeoutMs);

      child.stdout.on("data", async (chunk: Buffer) => {
        if (isDone || isTruncated) return;
        totalBytesStreamed += chunk.length;

        if (totalBytesStreamed >= SANDBOX_LIMITS.maxOutputBytes) {
          isTruncated = true;
          // Stop publishing, send one output truncated message, kill container
          const truncMsg = "\n[Output truncated: exceeded 1MB limit]\n";
          if (stderrAccum.length < maxDbChars) {
            stderrAccum += truncMsg.slice(0, maxDbChars - stderrAccum.length);
          }
          await redis.publish(channel, JSON.stringify({ type: "stderr", data: truncMsg }));
          execFile("docker", ["rm", "-f", containerName], () => {});
          child.kill("SIGKILL");
          return;
        }

        const text = chunk.toString();
        if (stdoutAccum.length < maxDbChars) {
          stdoutAccum += text.slice(0, maxDbChars - stdoutAccum.length);
        }
        await redis.publish(channel, JSON.stringify({ type: "stdout", data: text }));
      });

      child.stderr.on("data", async (chunk: Buffer) => {
        if (isDone || isTruncated) return;
        totalBytesStreamed += chunk.length;

        if (totalBytesStreamed >= SANDBOX_LIMITS.maxOutputBytes) {
          isTruncated = true;
          const truncMsg = "\n[Output truncated: exceeded 1MB limit]\n";
          if (stderrAccum.length < maxDbChars) {
            stderrAccum += truncMsg.slice(0, maxDbChars - stderrAccum.length);
          }
          await redis.publish(channel, JSON.stringify({ type: "stderr", data: truncMsg }));
          execFile("docker", ["rm", "-f", containerName], () => {});
          child.kill("SIGKILL");
          return;
        }

        const text = chunk.toString();
        if (stderrAccum.length < maxDbChars) {
          stderrAccum += text.slice(0, maxDbChars - stderrAccum.length);
        }
        await redis.publish(channel, JSON.stringify({ type: "stderr", data: text }));
      });

      child.on("error", (err) => {
        if (isDone) return;
        isDone = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        reject(err);
      });

      child.on("close", async (code) => {
        if (isDone) return;
        if (code === 125) {
          // Docker daemon failure or unable to start container
          isDone = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          reject(new Error(`Docker execution failed (code 125): ${stderrAccum || "Docker daemon unavailable"}`));
          return;
        }

        isDone = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }

        const runTimeMs = Date.now() - startTime;
        let finalStatus: "passed" | "failed" | "timeout" | "killed" | "truncated" = "failed";

        if (isTimedOut) {
          finalStatus = "timeout";
        } else if (isTruncated) {
          finalStatus = "truncated";
        } else if (code === 137) {
          // Exit code 137 indicates OOM killer
          finalStatus = "killed";
          const oomMsg = "\nProcess killed: memory limit exceeded (OOM).\n";
          if (stderrAccum.length < maxDbChars) {
            stderrAccum += oomMsg.slice(0, maxDbChars - stderrAccum.length);
          }
          await redis.publish(channel, JSON.stringify({ type: "stderr", data: oomMsg }));
        } else if (stderrAccum.includes("Resource temporarily unavailable")) {
          finalStatus = "failed";
        } else if (code === 0) {
          finalStatus = "passed";
        } else {
          finalStatus = "failed";
        }

        await redis.publish(channel, JSON.stringify({ type: "end", status: finalStatus, code }));

        await prisma.executionLog
          .updateMany({
            where: { jobId },
            data: {
              status: finalStatus,
              runTimeMs,
              stdoutTrunc: stdoutAccum,
              stderrTrunc: stderrAccum,
            },
          })
          .catch((e) => console.warn(`[worker] DB update error on close for ${jobId}:`, e));

        const executionResult: ExecutionResult = {
          status: finalStatus,
          code,
          exitCode: code,
          stdout: stdoutAccum,
          stderr: stderrAccum,
          runTimeMs,
          stdoutTrunc: stdoutAccum,
          stderrTrunc: stderrAccum,
        };
        await redis.set(`execution:result:${jobId}`, JSON.stringify(executionResult), "EX", 300);
        resolve(executionResult);
      });
    });
  } finally {
    // Timer and container + temp dir cleanup happens in finally block in all exit paths
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    try {
      await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    } catch (e) {
      console.error("[worker] cleanup error in finally block:", e);
    }
  }
};
