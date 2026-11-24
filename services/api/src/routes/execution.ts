import { Router, Request, Response } from "express";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { authenticate } from "../middleware/auth";
import { logger } from "../middleware/logger";
import { prisma } from "../lib/prisma";
import { executionRateLimiter, sandboxRateLimiter } from "../middleware/rateLimit";
import { isRunnable } from "../lib/languages";

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
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "codesync-internal-ai-secret";

const verifyInternalAuth = (req: Request, res: Response, next: import("express").NextFunction) => {
  const secretHeader = req.get("x-internal-secret") || req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secretHeader || secretHeader !== INTERNAL_SECRET) {
    logger.warn({ ip: req.ip }, "Unauthorized internal sandbox request: missing or invalid secret");
    return res.status(401).json({ error: "Unauthorized: Invalid or missing internal secret header" });
  }
  next();
};

/**
 * POST /execution/sandbox
 * Internal/AI sandbox endpoint to run a project snapshot with a command.
 * Authenticated via internal shared secret header (X-Internal-Secret).
 * Rate-limited via sandboxRateLimiter.
 * Worker executes in hardened container with ALL limits preserved.
 */
router.post("/sandbox", verifyInternalAuth, sandboxRateLimiter, async (req: Request, res: Response) => {
  try {
    const { roomId, files, command, language } = req.body;
    if (!files || !command || !language) {
      return res.status(400).json({ error: "Missing required fields: files, command, language" });
    }
    if (!isRunnable(language) && language !== "sh") {
      return res.status(400).json({ error: `Running ${language} code is not supported.` });
    }

    const payloadStr = JSON.stringify(files);
    if (Buffer.byteLength(payloadStr, "utf8") > 1024 * 1024) {
      return res.status(413).json({ error: "Snapshot payload exceeds 1MB limit" });
    }

    const jobCounts = await executionQueue.getJobCounts("waiting", "active", "delayed");
    const totalInFlight = jobCounts.waiting + jobCounts.active + jobCounts.delayed;
    if (totalInFlight >= MAX_QUEUE_LENGTH) {
      return res.status(503).json({ error: "busy, retry shortly" });
    }

    const jobId = uuidv4();
    const effectiveRoomId = roomId || "ai-sandbox";

    await executionQueue.add(
      "run",
      {
        roomId: effectiveRoomId,
        files,
        command,
        language,
        isSnapshot: true,
      },
      {
        jobId,
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 5000 },
      }
    );

    const resultKey = `execution:result:${jobId}`;
    const startTime = Date.now();
    const maxWaitMs = 25000;

    while (Date.now() - startTime < maxWaitMs) {
      const raw = await redisConnection.get(resultKey);
      if (raw) {
        const result = JSON.parse(raw);
        return res.json({
          status: result.status,
          exitCode: result.exitCode ?? result.code,
          stdout: result.stdout ?? result.stdoutTrunc ?? "",
          stderr: result.stderr ?? result.stderrTrunc ?? "",
          runTimeMs: result.runTimeMs,
        });
      }
      await new Promise((r) => setTimeout(r, 80));
    }

    return res.status(504).json({ error: "Sandbox execution timed out" });
  } catch (err: any) {
    logger.error({ err }, "Sandbox execution error");
    return res.status(500).json({ error: err.message });
  }
});

router.use(authenticate);

router.post("/", executionRateLimiter, async (req: Request, res: Response) => {
  try {
    const { roomId, code, language } = req.body;
    if (!roomId || !code || !language) {
      return res.status(400).json({ error: "Missing required fields: roomId, code, language" });
    }
    if (!isRunnable(language) && language !== "sh") {
      return res.status(400).json({ error: `Running ${language} code is not supported yet.` });
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
    // Must outlive the job's time in the queue: with a 30 s TTL, jobs queued longer
    // lost their signal and the worker waited the full 5 s for it (Phase 6 B2). The
    // worker pops the key when it runs; the TTL only cleans up jobs that never run.
    await redisConnection.expire(readyKey, 600);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to signal execution ready");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
