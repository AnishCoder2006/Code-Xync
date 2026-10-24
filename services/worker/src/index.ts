import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { runInDocker } from "./sandbox/dockerRunner";

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

const worker = new Worker("code_execution", async (job: Job) => {
  const { code, language, roomId } = job.data;
  console.log(`Executing job ${job.id} for room ${roomId}`);
  
  await runInDocker(job.id as string, roomId, code, language, redisConnection);
}, { connection: redisConnection });

worker.on("completed", job => {
  console.log(`Job ${job.id} completed!`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed with error ${err.message}`);
});

console.log("Execution Worker started...");
