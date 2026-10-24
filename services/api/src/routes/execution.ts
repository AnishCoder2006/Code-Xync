import { Router, Request, Response } from "express";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { requireAuth } from "@clerk/express";
import { attachUser } from "../middleware/auth";
import { logger } from "../middleware/logger";
import { prisma } from "../lib/prisma";

const router = Router();
const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const executionQueue = new Queue("code_execution", { connection: redisConnection });

router.use(requireAuth());
router.use(attachUser);

router.post("/", async (req: Request, res: Response) => {
  try {
    const { roomId, code, language } = req.body;
    if (!roomId || !code || !language) return res.status(400).json({ error: "Missing fields" });

    const jobId = uuidv4();

    // Enqueue with NO delay. The worker will block on a Redis ready-signal
    // before emitting any output — see dockerRunner.ts readyKey logic.
    await executionQueue.add("run", { roomId, code, language }, { jobId });

    // Audit log
    await prisma.executionLog.create({
      data: {
        roomId,
        userId: req.user!.id,
        jobId,
        status: "queued"
      }
    });

    // Return jobId immediately so the frontend can open its terminal subscription.
    // The worker waits for the frontend to signal ready before streaming output.
    res.json({ jobId });
  } catch (err) {
    logger.error({ err }, "Failed to enqueue execution job");
    res.status(500).json({ error: "Internal error" });
  }
});

/**
 * POST /execution/:jobId/ready
 * Called by the frontend (or Sync service) once the terminal WS subscription
 * is open. Unblocks the worker so it starts streaming output.
 * This closes the race where fast-exiting scripts finish before anyone is listening.
 */
router.post("/:jobId/ready", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const readyKey = `execution:ready:${jobId}`;
    // LPUSH a single item; the worker does BLPOP on this key (5s timeout)
    await redisConnection.lpush(readyKey, "1");
    // Auto-expire so orphaned keys don't accumulate
    await redisConnection.expire(readyKey, 30);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to signal execution ready");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
