import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { execFile } from "child_process";
import { promisify } from "util";
import { runInDocker, runningContainers } from "./sandbox/dockerRunner";
import { warmPool } from "./sandbox/warmPool";
import { prisma } from "./lib/prisma";

const execFileAsync = promisify(execFile);

const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redisConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const concurrency = parseInt(process.env.WORKER_CONCURRENCY || "4", 10);
const activeContainers = new Set<string>();

const worker = new Worker(
  "code_execution",
  async (job: Job) => {
    const { code, language, roomId, files, command, isSnapshot } = job.data;
    const jobId = job.id as string;
    const containerName = `codesync-job-${jobId}`;
    activeContainers.add(containerName);

    console.log(`[worker] Executing job ${jobId} (attempt ${job.attemptsMade + 1}) for room ${roomId}`);

    try {
      const result = await runInDocker(
        jobId,
        roomId,
        code || "",
        language,
        redisConnection,
        { files, command, isSnapshot: isSnapshot || !!files, enqueuedAt: job.timestamp, pickedAt: job.processedOn }
      );
      return result;
    } finally {
      activeContainers.delete(containerName);
    }
  },
  {
    connection: redisConnection,
    concurrency,
    stalledInterval: 5000,
    maxStalledCount: 2,
    lockDuration: 10000,
  }
);

worker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} completed!`);
});

worker.on("failed", async (job, err) => {
  console.error(`[worker] Job ${job?.id} failed with error: ${err.message}`);

  if (!job) return;

  const jobId = job.id as string;
  const maxAttempts = job.opts.attempts ?? 1;

  // Only update DB and notify terminal when all retries are exhausted
  if (job.attemptsMade >= maxAttempts) {
    const { roomId } = job.data;
    const channel = `room:${roomId}:execution:${jobId}`;

    console.warn(`[worker] Job ${jobId} exhausted all ${maxAttempts} attempts. Marking failed in DB and notifying terminal.`);

    // Publish terminal end event so the UI doesn't hang
    await redisConnection
      .publish(channel, JSON.stringify({ type: "end", status: "failed", code: 1 }))
      .catch((e) => console.error(`[worker] Failed to publish end event for ${jobId}:`, e));

    // Update ExecutionLog to failed
    await prisma.executionLog
      .updateMany({
        where: { jobId },
        data: {
          status: "failed",
          stderrTrunc: err.message.slice(0, 10240),
        },
      })
      .catch((e) => console.error(`[worker] Failed to update ExecutionLog for ${jobId}:`, e));
  }
});

worker.on("stalled", (jobId) => {
  console.warn(`[worker] Job ${jobId} stalled! Will be re-assigned.`);
});

// ── Graceful shutdown ──
let isShuttingDown = false;
const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[worker] Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new jobs
  try {
    await worker.close();
  } catch (err) {
    console.error("[worker] Error closing worker:", err);
  }

  // Stop the warm pool (idle pre-started containers) and kill running containers
  // immediately to release resources (warm containers carry their own names).
  warmPool.stop();
  for (const containerName of new Set([...activeContainers, ...runningContainers])) {
    console.log(`[worker] Killing running container: ${containerName}`);
    try {
      await execFileAsync("docker", ["rm", "-f", containerName]);
    } catch {}
  }
  activeContainers.clear();

  // Disconnect Redis
  try {
    await redisConnection.quit();
  } catch {}

  console.log("[worker] Graceful shutdown complete. Exiting.");
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

warmPool.start();
console.log(`Execution Worker started with concurrency ${concurrency}...${warmPool.enabled ? ` (warm pool: ${process.env.SANDBOX_WARM_POOL_SIZE} per language)` : ""}`);

export { worker, redisConnection };
