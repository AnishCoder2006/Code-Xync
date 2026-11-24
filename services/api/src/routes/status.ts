import { Router, Request, Response } from "express";
import Redis from "ioredis";
import { authenticate } from "../middleware/auth";
import { executionQueue } from "./execution";

/**
 * GET /status — live health of every part of the system, for the System page.
 * Signed-in users only (it names internal nodes). Each probe has a short timeout and
 * reports its own failure instead of failing the whole response.
 */
const router = Router();
router.use(authenticate);

const startedAt = Date.now();
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "codesync-internal-ai-secret";
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380", { maxRetriesPerRequest: 1, lazyConnect: false });
redis.on("error", () => {});

type Probe<T> = { ok: boolean; latencyMs: number; error?: string } & Partial<T>;

async function timed<T>(fn: () => Promise<T>, timeoutMs = 2000): Promise<Probe<T>> {
  const t0 = Date.now();
  try {
    const data = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs)),
    ]);
    return { ok: true, latencyMs: Date.now() - t0, ...(data as any) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message } as Probe<T>;
  }
}

const getJson = async (url: string, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<any>;
};

async function syncNodes() {
  const base = (process.env.SYNC_SERVICE_URL || "http://localhost:4001").replace(/\/$/, "");
  // Behind the Node LB the backend list is at /__lb/status; a single node has none.
  let backends: { host: string; port: number; healthy: boolean; nodeId: string; routedWs: number }[] | null = null;
  try {
    const r = await fetch(`${base}/__lb/status`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const body = await r.json();
      if (Array.isArray(body)) backends = body;
    }
  } catch {}
  const targets = backends ? backends.map((b) => ({ url: `http://${b.host}:${b.port}`, lb: b })) : [{ url: base, lb: null }];
  const nodes = await Promise.all(
    targets.map(async ({ url, lb }) => {
      const p = await timed(() => getJson(`${url}/health`, { "x-internal-secret": INTERNAL_SECRET }));
      const h = p as any;
      return {
        nodeId: h.nodeId ?? lb?.nodeId ?? url,
        ok: p.ok,
        latencyMs: p.latencyMs,
        error: p.error,
        rooms: h.rooms ?? null,
        clients: h.clients ?? null,
        uptimeMs: h.uptimeMs ?? null,
        redis: h.redis ?? null,
        routedWs: lb?.routedWs ?? null,
        published: h.relay?.publishedUpdates ?? null,
        received: h.relay?.receivedUpdates ?? null,
      };
    })
  );
  return { loadBalanced: !!backends, nodes };
}

router.get("/", async (_req: Request, res: Response) => {
  const [redisProbe, queue, sync, ai] = await Promise.all([
    timed(async () => ({ reply: await redis.ping() })),
    timed(async () => ({ counts: await executionQueue.getJobCounts("waiting", "active", "delayed", "completed", "failed") })),
    syncNodes(),
    timed(() => getJson(`${(process.env.AI_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "")}/health`)),
  ]);
  res.json({
    checkedAt: new Date().toISOString(),
    api: { ok: true, uptimeMs: Date.now() - startedAt, nodeEnv: process.env.NODE_ENV ?? "development" },
    redis: { ok: redisProbe.ok, latencyMs: redisProbe.latencyMs, error: redisProbe.error },
    queue: {
      ok: queue.ok,
      error: queue.error,
      ...(queue as any).counts,
      maxQueueLength: Number(process.env.MAX_QUEUE_LENGTH || 50),
      ratePerMinute: Number(process.env.EXECUTION_RATE_PER_MIN || 10),
    },
    sync,
    ai: { ok: ai.ok, latencyMs: ai.latencyMs, error: ai.error, provider: (ai as any).llm_provider ?? null },
  });
});

export default router;
