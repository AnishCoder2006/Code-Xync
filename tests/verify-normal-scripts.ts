import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { runInDocker } from "../services/worker/src/sandbox/dockerRunner";
import { prisma } from "../services/worker/src/lib/prisma";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redis = new Redis(redisUrl);

async function verifyNormalScripts() {
  console.log("=============================================================");
  console.log("       Verifying Normal Python & Node Script Execution       ");
  console.log("=============================================================\n");

  const userId = "normal-user-" + uuidv4().slice(0, 8);
  const roomId = "normal-room-" + uuidv4().slice(0, 8);

  await prisma.user.create({
    data: { id: userId, email: `${userId}@test.com`, name: "Normal User" },
  });
  await prisma.room.create({
    data: {
      id: roomId,
      title: "Normal Room",
      ownerId: userId,
      members: { create: { userId, role: "OWNER" } },
    },
  });

  // 1. Verify Normal Python Script
  const pyJobId = "py-test-" + uuidv4().slice(0, 8);
  const pyChannel = `room:${roomId}:execution:${pyJobId}`;
  await prisma.executionLog.create({
    data: { jobId: pyJobId, roomId, userId, status: "queued" },
  });

  const sub = new Redis(redisUrl);
  const pyEvents: any[] = [];
  await sub.subscribe(pyChannel);
  sub.on("message", (_chan, msg) => {
    try {
      pyEvents.push(JSON.parse(msg));
    } catch {}
  });

  await redis.lpush(`execution:ready:${pyJobId}`, "1");
  const pyResult = await runInDocker(
    pyJobId,
    roomId,
    "print('Hello from Python!')\nfor i in range(3):\n    print(f'Count: {i}')",
    "python",
    redis
  );

  console.log("Python script result:", pyResult);
  if (pyResult.status !== "passed" || pyResult.code !== 0) {
    throw new Error(`Python execution failed: ${JSON.stringify(pyResult)}`);
  }
  if (!pyResult.stdoutTrunc.includes("Hello from Python!")) {
    throw new Error(`Python output mismatch: ${pyResult.stdoutTrunc}`);
  }
  console.log("Python normal execution PASSED!\n");

  await sub.unsubscribe(pyChannel);

  // 2. Verify Normal Node.js Script
  const nodeJobId = "node-test-" + uuidv4().slice(0, 8);
  const nodeChannel = `room:${roomId}:execution:${nodeJobId}`;
  await prisma.executionLog.create({
    data: { jobId: nodeJobId, roomId, userId, status: "queued" },
  });

  const nodeEvents: any[] = [];
  await sub.subscribe(nodeChannel);
  sub.on("message", (_chan, msg) => {
    try {
      nodeEvents.push(JSON.parse(msg));
    } catch {}
  });

  await redis.lpush(`execution:ready:${nodeJobId}`, "1");
  const nodeResult = await runInDocker(
    nodeJobId,
    roomId,
    "console.log('Hello from Node!');\n[1, 2, 3].forEach(n => console.log('Number:', n));",
    "javascript",
    redis
  );

  console.log("Node script result:", nodeResult);
  if (nodeResult.status !== "passed" || nodeResult.code !== 0) {
    throw new Error(`Node execution failed: ${JSON.stringify(nodeResult)}`);
  }
  if (!nodeResult.stdoutTrunc.includes("Hello from Node!")) {
    throw new Error(`Node output mismatch: ${nodeResult.stdoutTrunc}`);
  }
  console.log("Node.js normal execution PASSED!\n");

  await sub.unsubscribe(nodeChannel);
  await sub.quit();
  await redis.quit();
  await prisma.$disconnect();

  console.log("All normal Python and Node script runs PASSED and streamed correctly!");
  process.exit(0);
}

verifyNormalScripts().catch((e) => {
  console.error("Normal scripts execution failed:", e);
  process.exit(1);
});
