import { Request, Response, NextFunction } from "express";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");

interface RateLimitOptions {
  windowMs?: number;
  limit?: number;
}

export const createRateLimiter = (options?: RateLimitOptions) => {
  const windowMs = options?.windowMs ?? 60000;
  const limit = options?.limit ?? parseInt(process.env.EXECUTION_RATE_PER_MIN || "10", 10);

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return next();
      }

      const key = `ratelimit:${userId}:execution`;
      const now = Date.now();
      const clearBefore = now - windowMs;

      // Sliding window via Redis Sorted Set
      const multi = redis.multi();
      multi.zremrangebyscore(key, 0, clearBefore);
      multi.zcard(key);
      multi.zrange(key, 0, 0, "WITHSCORES");

      const results = await multi.exec();
      if (!results) {
        return next();
      }

      const count = (results[1][1] as number) || 0;
      const oldestEntries = (results[2][1] as string[]) || [];

      if (count >= limit) {
        let retryAfterSec = 60;
        if (oldestEntries.length >= 2) {
          const oldestScore = parseInt(oldestEntries[1], 10);
          const timeToWaitMs = oldestScore + windowMs - now;
          retryAfterSec = Math.max(1, Math.ceil(timeToWaitMs / 1000));
        }

        res.setHeader("Retry-After", retryAfterSec.toString());
        return res.status(429).json({
          error: "Rate limit exceeded. Maximum 10 runs per minute allowed.",
          retryAfter: retryAfterSec,
        });
      }

      // Add current request to window
      const member = `${now}-${Math.random()}`;
      await redis
        .multi()
        .zadd(key, now, member)
        .pexpire(key, windowMs * 2)
        .exec();

      next();
    } catch (error) {
      console.error("[rateLimit] Redis error checking rate limit:", error);
      // Fail-open on Redis errors to prevent total outage
      next();
    }
  };
};

export const executionRateLimiter = createRateLimiter();
