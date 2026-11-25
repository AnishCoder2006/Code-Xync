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

const MAX_STDIN_BYTES = 64 * 1024; // program input per run
const MAX_BATCH_CASES = 10;

type RunRequest = { roomId: string; code: string; language: string };
type Rejection = { status: number; error: string };

/**
 * Checks shared by single runs and test-case batches: fields, language, code size,
 * OWNER/EDITOR membership (viewers get 403) and room in the queue for `jobs` more jobs.
 */
async function checkRun(req: Request, jobs: number): Promise<Rejection | RunRequest> {
  const { roomId, code, language } = req.body ?? {};
  if (!roomId || !code || !language) return { status: 400, error: "Missing required fields: roomId, code, language" };
  if (!isRunnable(language) && language !== "sh") return { status: 400, error: `Running ${language} code is not supported yet.` };
  if (!req.user) return { status: 401, error: "Unauthorized" };

  const codeSizeBytes = Buffer.byteLength(code, "utf8");
  if (codeSizeBytes > MAX_CODE_SIZE_BYTES) {
    return { status: 413, error: `Payload too large. Code size (${codeSizeBytes} bytes) exceeds limit of ${MAX_CODE_SIZE_BYTES} bytes.` };
  }

  const membership = await prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId: req.user.id } } });
  if (!membership || (membership.role !== "OWNER" && membership.role !== "EDITOR")) {
    logger.warn({ userId: req.user.id, roomId, role: membership?.role }, "Non-editor/viewer attempted execution");
    return { status: 403, error: "Forbidden: Viewer cannot execute code" };
  }

  const jobCounts = await executionQueue.getJobCounts("waiting", "active", "delayed");
  const totalInFlight = jobCounts.waiting + jobCounts.active + jobCounts.delayed;
  if (totalInFlight + jobs > MAX_QUEUE_LENGTH) {
    logger.warn({ totalInFlight, jobs, max: MAX_QUEUE_LENGTH }, "Execution queue saturated");
    return { status: 503, error: "busy, retry shortly" };
  }
  return { roomId, code, language };
}

const stdinError = (stdin: unknown): string | null => {
  if (stdin === undefined || stdin === null) return null;
  if (typeof stdin !== "string") return "stdin must be a string";
  if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES) return `Input is too large (limit ${MAX_STDIN_BYTES / 1024} KB).`;
  return null;
};

/**
 * Audit log row ('queued') first, then the job. `stdin` is piped to the program;
 * `batch` jobs have no live terminal, so the worker doesn't wait for a ready signal.
 */
async function enqueueRun(run: RunRequest, userId: string, opts: { stdin?: string; batch?: boolean } = {}): Promise<string> {
  const jobId = uuidv4();
  await prisma.executionLog.create({ data: { roomId: run.roomId, userId, jobId, status: "queued" } });
  try {
    await executionQueue.add(
      "run",
      { ...run, userId, ...(opts.stdin ? { stdin: opts.stdin } : {}), ...(opts.batch ? { batch: true } : {}) },
      {
        jobId,
        attempts: 2,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 5000 },
      }
    );
  } catch (enqueueErr) {
    logger.error({ err: enqueueErr, jobId }, "executionQueue.add failed; updating ExecutionLog status to failed");
    await prisma.executionLog
      .updateMany({ where: { jobId }, data: { status: "failed", stderrTrunc: "Failed to enqueue execution job" } })
      .catch((e) => logger.error({ err: e }, "Failed to update ExecutionLog to failed"));
    throw enqueueErr;
  }
  return jobId;
}

/** POST /execution  { roomId, code, language, stdin? }  -> { jobId }; output streams to the terminal. */
router.post("/", executionRateLimiter, async (req: Request, res: Response) => {
  try {
    const badStdin = stdinError(req.body?.stdin);
    if (badStdin) return res.status(badStdin.includes("too large") ? 413 : 400).json({ error: badStdin });
    const run = await checkRun(req, 1);
    if ("error" in run) return res.status(run.status).json({ error: run.error });
    try {
      const jobId = await enqueueRun(run, req.user!.id, { stdin: req.body.stdin || undefined });
      res.json({ jobId });
    } catch {
      res.status(500).json({ error: "Failed to enqueue execution job" });
    }
  } catch (err) {
    logger.error({ err }, "Failed to enqueue execution job");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /execution/batch  { roomId, code, language, cases: [{ stdin }] }  -> { jobIds }
 * Runs the same program once per test case (up to 10). Counts as ONE run for the rate
 * limit. Poll GET /execution/:jobId/result for each case's output.
 */
router.post("/batch", executionRateLimiter, async (req: Request, res: Response) => {
  try {
    const cases = req.body?.cases;
    if (!Array.isArray(cases) || cases.length === 0) return res.status(400).json({ error: "cases must be a non-empty array" });
    if (cases.length > MAX_BATCH_CASES) return res.status(400).json({ error: `At most ${MAX_BATCH_CASES} test cases per run.` });
    for (const c of cases) {
      const bad = stdinError(c?.stdin);
      if (bad) return res.status(bad.includes("too large") ? 413 : 400).json({ error: bad });
    }
    const run = await checkRun(req, cases.length);
    if ("error" in run) return res.status(run.status).json({ error: run.error });
    try {
      const jobIds: string[] = [];
      for (const c of cases) jobIds.push(await enqueueRun(run, req.user!.id, { stdin: c?.stdin || undefined, batch: true }));
      res.json({ jobIds });
    } catch {
      res.status(500).json({ error: "Failed to enqueue execution job" });
    }
  } catch (err) {
    logger.error({ err }, "Failed to enqueue execution batch");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /execution/:jobId/result  -> { done, status, exitCode, stdout, stderr, runTimeMs }
 * Any member of the job's room may read it. The worker's Redis result (kept 5 min) has
 * the exit code; after that the audit log still has status and output (10 KB each).
 */
router.get("/:jobId/result", async (req: Request, res: Response) => {
  try {
    const log = await prisma.executionLog.findUnique({
      where: { jobId: req.params.jobId },
      select: { roomId: true, status: true, stdoutTrunc: true, stderrTrunc: true, runTimeMs: true },
    });
    if (!log) return res.status(404).json({ error: "Run not found" });
    const member = await prisma.roomMember.findUnique({ where: { roomId_userId: { roomId: log.roomId, userId: req.user!.id } } });
    if (!member) return res.status(404).json({ error: "Run not found" });

    const raw = await redisConnection.get(`execution:result:${req.params.jobId}`);
    if (raw) {
      const r = JSON.parse(raw);
      return res.json({
        done: true,
        status: r.status,
        exitCode: r.exitCode ?? r.code ?? null,
        stdout: r.stdoutTrunc ?? r.stdout ?? "",
        stderr: r.stderrTrunc ?? r.stderr ?? "",
        runTimeMs: r.runTimeMs ?? null,
      });
    }
    const done = log.status !== "queued" && log.status !== "running";
    res.json({
      done,
      status: log.status,
      exitCode: log.status === "passed" ? 0 : null,
      stdout: log.stdoutTrunc ?? "",
      stderr: log.stderrTrunc ?? "",
      runTimeMs: log.runTimeMs,
    });
  } catch (err) {
    logger.error({ err }, "Failed to read execution result");
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
