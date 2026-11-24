import { Request, Response, NextFunction } from "express";

/**
 * CORS for the browser app when it runs on a different origin than the API
 * (local dev: web :3000 -> api :4000; UI tests: web :3100 -> api :4050).
 * Behind Nginx in production the app and /api/ share one origin and this is unused.
 *
 * Only origins listed in CORS_ORIGINS (comma-separated) are allowed. Auth is a bearer
 * token (Clerk getToken() / test token), so no cookies are needed cross-origin.
 */
const DEFAULT_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000";

export function corsMiddleware() {
  const allowed = new Set(
    (process.env.CORS_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean)
  );
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Retry-After");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS") return res.status(204).end();
    }
    next();
  };
}
