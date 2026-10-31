import { Router, Request, Response } from "express";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { requireAuth } from "@clerk/express";
import { attachUser } from "../middleware/auth";
import { logger } from "../middleware/logger";
import { prisma } from "../lib/prisma";
import { executionRateLimiter } from "../middleware/rateLimit";

const router = Router();
const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redisConnection = new Redis(redisUrl);

export const executionQueue = new Queue("code_execution", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: {
      age: 3600, // 1 hour
      count: 1000,
    },
    removeOnFail: {
      age: 86400, // 24 hours
      count: 5000,
    },
  },
});

const MAX_CODE_SIZE_BYTES = 100 * 1024; // 100 KB max code size
const MAX_QUEUE_LENGTH = parseInt(process.env.MAX_QUEUE_LENGTH || "50", 10);

if (process.env.NODE_ENV === "test") {
  router.use((req: Request, res: Response, next: import("express").NextFunction) => {
    if (req.user) return next();
    return requireAuth()(req, res, () => attachUser(req, res, next));
  });
} else {
  router.use(requireAuth());
  router.use(attachUser);
}

router.post("/", executionRateLimiter, async (req: Request, res: Response) => {
  try {
    const { roomId, code, language } = req.body;
    if (!roomId || !code || !language) {
      return res.status(400).json({ error: "Missing required fields: roomId, code, language" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 1. Validate max code size (reject > 100 KB with 413)
    const codeSizeBytes = Buffer.byteLength(code, "utf8");
    if (codeSizeBytes > MAX_CODE_SIZE_BYTES) {
      return res.status(413).json({
        error: `Payload too large. Code size (${codeSizeBytes} bytes) exceeds limit of ${MAX_CODE_SIZE_BYTES} bytes.`,
      });
    }

    // 2. Verify RoomMember role is OWNER or EDITOR (viewers get 403)
    const membership = await prisma.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId,
          userId: req.user.id,
        },
      },
    });

    if (!membership || (membership.role !== "OWNER" && membership.role !== "EDITOR")) {
      logger.warn({ userId: req.user.id, roomId, role: membership?.role }, "Non-editor/viewer attempted execution");
      return res.status(403).json({ error: "Forbidden: Viewer cannot execute code" });
    }

    // 3. Check queue backlog / capacity (return 503 if queue is full)
    const jobCounts = await executionQueue.getJobCounts("waiting", "active", "delayed");
    const totalInFlight = jobCounts.waiting + jobCounts.active + jobCounts.delayed;
    if (totalInFlight >= MAX_QUEUE_LENGTH) {
      logger.warn({ totalInFlight, max: MAX_QUEUE_LENGTH }, "Execution queue saturated");
      return res.status(503).json({ error: "busy, retry shortly" });
    }

    const jobId = uuidv4();

    // 4. Initial audit log with status 'queued' BEFORE executionQueue.add
    await prisma.executionLog.create({
      data: {
        roomId,
        userId: req.user.id,
        jobId,
        status: "queued",
      },
    });

    // 5. Enqueue execution job with retry attempts and backoff
    try {
      await executionQueue.add(
        "run",
        { roomId, code, language, userId: req.user.id },
        {
          jobId,
          attempts: 2,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
          removeOnComplete: {
            age: 3600,
            count: 1000,
          },
          removeOnFail: {
            age: 86400,
            count: 5000,
          },
        }
      );
    } catch (enqueueErr) {
      logger.error({ err: enqueueErr, jobId }, "executionQueue.add failed; updating ExecutionLog status to failed");
      await prisma.executionLog
        .updateMany({
          where: { jobId },
          data: { status: "failed", stderrTrunc: "Failed to enqueue execution job" },
        })
        .catch((e) => logger.error({ err: e }, "Failed to update ExecutionLog to failed"));
      return res.status(500).json({ error: "Failed to enqueue execution job" });
    }

    res.json({ jobId });
  } catch (err) {
    logger.error({ err }, "Failed to enqueue execution job");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /execution/:jobId/ready
 * Unblocks the worker so it starts streaming output once the terminal WS is listening.
 */
router.post("/:jobId/ready", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const readyKey = `execution:ready:${jobId}`;
    await redisConnection.lpush(readyKey, "1");
    await redisConnection.expire(readyKey, 30);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to signal execution ready");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
