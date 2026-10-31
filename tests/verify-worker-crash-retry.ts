import { spawn, execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { prisma } from "../services/worker/src/lib/prisma";

const execFileAsync = promisify(execFile);
const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redis = new Redis(redisUrl);

async function runWorkerRetryVerification() {
  console.log("=============================================================");
  console.log("       Verifying Worker Crash Recovery & Stalled Retry       ");
  console.log("=============================================================\n");

  const jobId = "retry-test-" + uuidv4().slice(0, 8);
  const roomId = "retry-room-" + uuidv4().slice(0, 8);
  const userId = "retry-user-" + uuidv4().slice(0, 8);
  const containerName = `codesync-job-${jobId}`;
  const channel = `room:${roomId}:execution:${jobId}`;

  // Create user and room in DB
  await prisma.user.create({
    data: { id: userId, email: `${userId}@test.com`, name: "Retry User" },
  });
  await prisma.room.create({
    data: {
      id: roomId,
      title: "Retry Room",
      ownerId: userId,
      members: { create: { userId, role: "OWNER" } },
    },
  });

  // Create initial DB execution log
  await prisma.executionLog.create({
    data: { jobId, roomId, userId, status: "queued" },
  });

  // Subscribe to execution output channel
  const sub = new Redis(redisUrl);
  const publishedMessages: any[] = [];
  await sub.subscribe(channel);
  sub.on("message", (_chan, msg) => {
    try {
      publishedMessages.push(JSON.parse(msg));
    } catch {}
  });

  // Clean up any stale keys from previous runs
  const staleKeys = await redis.keys("bull:code_execution:*");
  if (staleKeys.length > 0) {
    await redis.del(...staleKeys);
  }

  // Enqueue job with BullMQ (attempts: 2)
  const queue = new Queue("code_execution", { connection: redis });
  await queue.add(
    "run",
    {
      roomId,
      code: "import time\ntime.sleep(2)\nprint('CRASH_RECOVERY_SUCCESS')",
      language: "python",
      userId,
    },
    {
      jobId,
      attempts: 2,
      backoff: { type: "exponential", delay: 1000 },
    }
  );

  console.log(`[Step 1] Job ${jobId} enqueued with attempts: 2.`);

  // Signal ready rendezvous
  await redis.lpush(`execution:ready:${jobId}`, "1");

  // Spawn Worker 1
  console.log("[Step 2] Spawning Worker 1...");
  const worker1 = spawn("npx", ["tsx", "services/worker/src/index.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, REDIS_URL: redisUrl, WORKER_CONCURRENCY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  worker1.stdout.on("data", (d) => {
    const text = d.toString();
    if (text.includes("Executing job") || text.includes("Execution Worker started")) {
      console.log(`[Worker 1 stdout]: ${text.trim()}`);
    }
  });

  // Wait until Worker 1 spawns the container
  console.log("[Step 3] Waiting for container to be spawned by Worker 1...");
  let containerFound = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const { stdout } = await execFileAsync("docker", [
        "ps",
        "--filter",
        `name=${containerName}`,
        "--format",
        "{{.Names}}",
      ]);
      if (stdout.includes(containerName)) {
        containerFound = true;
        console.log(`Container ${containerName} is actively running!`);
        break;
      }
    } catch {}
  }

  if (!containerFound) {
    worker1.kill("SIGKILL");
    throw new Error("Worker 1 failed to spawn container within timeout");
  }

  // Force kill Worker 1 process mid-run!
  console.log(`[Step 4] Killing Worker 1 process (PID ${worker1.pid}) mid-execution...`);
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/pid", String(worker1.pid), "/T", "/F"]);
    } catch {}
  } else {
    worker1.kill("SIGKILL");
  }
  console.log("Worker 1 killed!");

  // Worker 1 process was killed without cleanly closing the container or completing the BullMQ job.
  // Now spawn Worker 2 to recover the stalled job.
  console.log("[Step 5] Spawning Worker 2 to recover stalled/interrupted job...");
  const worker2 = spawn("npx", ["tsx", "services/worker/src/index.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, REDIS_URL: redisUrl, WORKER_CONCURRENCY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  worker2.stdout.on("data", (d) => {
    const text = d.toString();
    if (text.includes("Executing job") || text.includes("completed") || text.includes("stalled")) {
      console.log(`[Worker 2 stdout]: ${text.trim()}`);
    }
  });

  // Also push ready signal for the retry run
  await redis.lpush(`execution:ready:${jobId}`, "1");

  // Wait for job completion in database and Redis
  console.log("[Step 6] Waiting for Worker 2 to complete job retry...");
  let finishedNormally = false;

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const log = await prisma.executionLog.findUnique({ where: { jobId } });
    if (log && log.status === "passed") {
      console.log(`ExecutionLog status verified: ${log.status}`);
      console.log(`stdout: ${log.stdoutTrunc}`);
      finishedNormally = true;
      break;
    }
  }

  // Clean up worker 2
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/pid", String(worker2.pid), "/T", "/F"]);
    } catch {}
  } else {
    worker2.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    worker2.kill("SIGKILL");
  }

  // Assert container was removed
  const { stdout: psCheck } = await execFileAsync("docker", [
    "ps",
    "-a",
    "--filter",
    `name=${containerName}`,
    "--format",
    "{{.Names}}",
  ]);

  const leftover = psCheck.trim().length > 0;
  console.log(`Leftover container check for ${containerName}: ${leftover ? "LEFTOVER FOUND" : "CLEAN (0 leftovers)"}`);

  await sub.unsubscribe(channel);
  await sub.quit();
  await queue.close();
  await redis.quit();
  await prisma.$disconnect();

  if (!finishedNormally || leftover) {
    console.error("FAIL: Worker crash recovery test failed!");
    process.exit(1);
  }

  console.log("\nPASS: Worker killed mid-job was successfully retried by fresh worker and finished normally!");
  process.exit(0);
}

runWorkerRetryVerification().catch((e) => {
  console.error("Verification error:", e);
  process.exit(1);
});
