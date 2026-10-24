import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import Redis from "ioredis";

export const runInDocker = async (
  jobId: string,
  roomId: string,
  code: string,
  language: string,
  redis: Redis
) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `job-${jobId}-`));
  const filename = language === "python" ? "main.py" : "index.js";
  const filePath = path.join(tmpDir, filename);

  await fs.writeFile(filePath, code);

  // Use the scaffolded sandbox images from infra/docker/sandbox-images/
  // Build them first: docker build -f infra/docker/sandbox-images/node.Dockerfile -t codesync-sandbox-node .
  const image = language === "python" ? "codesync-sandbox-python" : "codesync-sandbox-node";
  const cmdArgs = language === "python" ? ["/app/main.py"] : ["/app/index.js"];
  const containerName = `codesync-job-${jobId}`;
  const channel = `room:${roomId}:execution:${jobId}`;
  const readyKey = `execution:ready:${jobId}`;

  // ── Wait for frontend to signal it has subscribed to the output channel ──
  // Frontend calls POST /execution/:jobId/ready which LPUSHes to this key.
  // BLPOP with a 5s timeout: if nobody signals in time we proceed anyway
  // (e.g. dev testing via curl) but in normal flow we wait for the terminal WS
  // to be open before emitting a single byte. This replaces the delay:1500 hack.
  const readyResult = await redis.blpop(readyKey, 5);
  if (!readyResult) {
    console.warn(`[worker] job ${jobId}: no ready signal in 5s, proceeding anyway`);
  }

  await redis.publish(channel, JSON.stringify({ type: "start", jobId }));

  return new Promise<void>((resolve, reject) => {
    // Basic limits: --network none + named container for reliable kill
    const dockerArgs = [
      "run",
      "--name", containerName,
      "--rm",
      "--network", "none",
      "-v", `${filePath}:/app/${filename}:ro`,
      image,
      ...cmdArgs,
    ];

    const child = spawn("docker", dockerArgs);
    let isDone = false;

    // ── 10-second hard timeout ──
    // Kills the real container via docker rm -f (not just the CLI process),
    // and guards against double-fire with isDone.
    const timeout = setTimeout(() => {
      if (isDone) return;
      spawn("docker", ["rm", "-f", containerName]);
      redis.publish(channel, JSON.stringify({ type: "stderr", data: "Execution timed out after 10s.\n" }));
    }, 10000);

    child.stdout.on("data", (data) => {
      redis.publish(channel, JSON.stringify({ type: "stdout", data: data.toString() }));
    });

    child.stderr.on("data", (data) => {
      redis.publish(channel, JSON.stringify({ type: "stderr", data: data.toString() }));
    });

    child.on("close", async (code) => {
      isDone = true;
      clearTimeout(timeout); // always cleared before container is considered done
      redis.publish(channel, JSON.stringify({ type: "end", code }));

      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
        // Failsafe: docker rm -f in case --rm missed it (e.g. OOM kill)
        spawn("docker", ["rm", "-f", containerName]);
      } catch (e) {
        console.error("[worker] cleanup error:", e);
      }

      if (code === 0) resolve();
      else reject(new Error(`Container exited with code ${code}`));
    });
  });
};
