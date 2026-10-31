import { spawn, execFile } from "child_process";
import { promisify } from "util";
import Redis from "ioredis";
import { runInDocker } from "../services/worker/src/sandbox/dockerRunner";
import { prisma } from "../services/worker/src/lib/prisma";

const execFileAsync = promisify(execFile);
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");

async function verifyDockerInspect() {
  const jobId = "inspect-test-job";
  const roomId = "inspect-test-room";
  const testUserId = "inspect-user";

  await prisma.user.upsert({
    where: { id: testUserId },
    create: { id: testUserId, email: "inspect@test.internal", name: "Inspect User" },
    update: {},
  });

  await prisma.room.upsert({
    where: { id: roomId },
    create: {
      id: roomId,
      title: "Inspect Test Room",
      ownerId: testUserId,
      members: { create: { userId: testUserId, role: "OWNER" } },
    },
    update: {},
  });

  await prisma.executionLog.create({
    data: { jobId, roomId, userId: testUserId, status: "queued" },
  });

  // Signal ready
  await redis.lpush(`execution:ready:${jobId}`, "1");

  // Start job in background
  const runPromise = runInDocker(jobId, roomId, "import time; time.sleep(3)", "python", redis);

  // Poll for container
  let inspected = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        `codesync-job-${jobId}`,
        "--format",
        JSON.stringify({
          NetworkMode: "{{.HostConfig.NetworkMode}}",
          ReadonlyRootfs: "{{.HostConfig.ReadonlyRootfs}}",
          Tmpfs: "{{json .HostConfig.Tmpfs}}",
          User: "{{.Config.User}}",
          CapDrop: "{{json .HostConfig.CapDrop}}",
          SecurityOpt: "{{json .HostConfig.SecurityOpt}}",
          Memory: "{{.HostConfig.Memory}}",
          MemorySwap: "{{.HostConfig.MemorySwap}}",
          NanoCpus: "{{.HostConfig.NanoCpus}}",
          PidsLimit: "{{.HostConfig.PidsLimit}}",
        }),
      ]);
      console.log("DOCKER_INSPECT_OUTPUT:");
      console.log(stdout.trim());
      inspected = true;
      break;
    } catch {}
  }

  await runPromise;
  await redis.quit();
  await prisma.$disconnect();

  if (!inspected) {
    throw new Error("Failed to inspect running container!");
  }
}

verifyDockerInspect().catch((e) => {
  console.error(e);
  process.exit(1);
});
