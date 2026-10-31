import Redis from "ioredis";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../services/worker/src/lib/prisma";

// Set invalid DOCKER_HOST to simulate Docker daemon being stopped / unavailable
process.env.DOCKER_HOST = "tcp://127.0.0.1:9999";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redis = new Redis(redisUrl);
const sub = new Redis(redisUrl);

async function runWorkerFailedVerification() {
  console.log("=============================================================");
  console.log("     Verifying worker.on('failed') on Docker Unreachable     ");
  console.log("=============================================================\n");

  const jobId = uuidv4();
  const roomId = "test-failed-room-" + jobId.slice(0, 8);
  const userId = "test-user-" + jobId.slice(0, 8);
  const channel = `room:${roomId}:execution:${jobId}`;

  // 1. Create test user and room
  await prisma.user.create({
    data: { id: userId, email: `${userId}@test.com`, name: "Tester" },
  });
  await prisma.room.create({
    data: {
      id: roomId,
      title: "Test Failed Room",
      ownerId: userId,
      members: { create: [{ userId, role: "OWNER" }] },
    },
  });

  // 2. Create ExecutionLog row (status: "queued")
  const initialRow = await prisma.executionLog.create({
    data: {
      jobId,
      roomId,
      userId,
      status: "queued",
    },
  });
  console.log("Created initial ExecutionLog row:");
  console.log(JSON.stringify(initialRow, null, 2));

  // 3. Listen for terminal events on Redis
  let receivedEndEvent: any = null;
  await sub.subscribe(channel);
  sub.on("message", (_ch, msg) => {
    try {
      const parsed = JSON.parse(msg);
      console.log(`[Redis Event on ${channel}]:`, parsed);
      if (parsed.type === "end") {
        receivedEndEvent = parsed;
      }
    } catch {}
  });

  // 4. Clean any leftover jobs in the queue
  const queue = new Queue("code_execution", {
    connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
  });
  await queue.drain();

  // Push ready signal immediately so worker doesn't wait 5s
  await redis.rpush(`execution:ready:${jobId}`, "ready");

  // 5. Start the worker
  const { worker } = await import("../services/worker/src/index");

  console.log(`\nSubmitting job ${jobId} with attempts: 2 to queue while Docker is stopped...`);
  await queue.add(
    "run",
    { roomId, code: "print('test')", language: "python", userId },
    {
      jobId,
      attempts: 2,
      backoff: { type: "exponential", delay: 500 },
    }
  );

  // Send ready signal periodically to unblock BLPOP on each retry attempt
  const readyInterval = setInterval(async () => {
    await redis.rpush(`execution:ready:${jobId}`, "ready");
  }, 200);

  // Wait for worker to exhaust attempts and process failed event
  console.log("Waiting for worker to exhaust attempts and trigger worker.on('failed')...");
  const startTime = Date.now();
  let updatedRow: any = null;

  while (Date.now() - startTime < 15000) {
    await new Promise((r) => setTimeout(r, 500));
    const row = await prisma.executionLog.findUnique({ where: { jobId } });
    if (row && row.status === "failed" && receivedEndEvent) {
      updatedRow = row;
      break;
    }
  }

  clearInterval(readyInterval);

  console.log("\n=================== VERIFICATION RESULTS ===================");
  console.log("Terminal End Event Received over Redis Pub/Sub:");
  console.log(JSON.stringify(receivedEndEvent, null, 2));

  console.log("\nFinal ExecutionLog Row in DB:");
  console.log(JSON.stringify(updatedRow, null, 2));

  if (!receivedEndEvent || receivedEndEvent.status !== "failed") {
    throw new Error("Failed to receive {type: 'end', status: 'failed'} on Redis channel");
  }
  if (!updatedRow || updatedRow.status !== "failed") {
    throw new Error("ExecutionLog row status was not updated to 'failed'");
  }

  console.log("\n worker.on('failed') verification PASSED successfully!");

  await worker.close();
  await queue.close();
  await sub.quit();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

runWorkerFailedVerification().catch((e) => {
  console.error("Verification failed:", e);
  process.exit(1);
});
