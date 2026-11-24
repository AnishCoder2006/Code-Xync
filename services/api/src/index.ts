// API service entrypoint — REST routes, auth, RBAC, job enqueue.
// See design doc section 1.2 (service responsibilities) and 3.2 (job queue).

if (process.env.NODE_ENV === "test" && process.env.CLERK_SECRET_KEY?.startsWith("sk_live")) {
  throw new Error("FATAL: Live Clerk secret key detected in test environment (NODE_ENV=test). Aborting startup to prevent accidental production mutations.");
}

import express from "express";
import { loggerMiddleware, logger } from "./middleware/logger";
import { corsMiddleware } from "./middleware/cors";
import roomsRouter from "./routes/rooms";
import executionRouter from "./routes/execution";
import aiRouter from "./routes/ai";
import meRouter from "./routes/me";
import statusRouter from "./routes/status";

const app = express();
app.use(corsMiddleware());
app.use(express.json());
app.use(loggerMiddleware);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/rooms", roomsRouter);
app.use("/execution", executionRouter);
app.use("/ai", aiRouter);
app.use("/me", meRouter);
app.use("/status", statusRouter);
app.use("/search", aiRouter);

const port = process.env.API_PORT ?? 4000;
app.listen(port, () => logger.info(`API listening on :${port}`));
