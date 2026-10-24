// API service entrypoint — REST routes, auth, RBAC, job enqueue.
// See design doc section 1.2 (service responsibilities) and 3.2 (job queue).
import express from "express";
import { loggerMiddleware, logger } from "./middleware/logger";
import roomsRouter from "./routes/rooms";
import executionRouter from "./routes/execution";
import aiRouter from "./routes/ai";

const app = express();
app.use(express.json());
app.use(loggerMiddleware);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/rooms", roomsRouter);
app.use("/execution", executionRouter);
app.use("/ai", aiRouter);

const port = process.env.API_PORT ?? 4000;
app.listen(port, () => logger.info(`API listening on :${port}`));
