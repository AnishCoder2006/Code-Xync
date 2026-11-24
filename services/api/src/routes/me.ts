import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { logger } from "../middleware/logger";
import { prisma } from "../lib/prisma";

const router = Router();
router.use(authenticate);

/**
 * GET /me/activity
 * The caller's own recent runs and AI fixes across all rooms they still belong to,
 * plus 7-day totals for the summary tiles.
 */
router.get("/activity", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const memberRooms = { room: { members: { some: { userId } } } };
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [runs, fixes, runs7, fixes7, accepted7] = await Promise.all([
      prisma.executionLog.findMany({
        where: { userId, ...memberRooms },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { jobId: true, status: true, runTimeMs: true, createdAt: true, room: { select: { id: true, title: true, defaultLang: true } } },
      }),
      prisma.aIInteraction.findMany({
        where: { userId, ...memberRooms },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: {
          id: true, prompt: true, status: true, attempts: true, costUsd: true, createdAt: true,
          room: { select: { id: true, title: true, defaultLang: true } },
        },
      }),
      prisma.executionLog.count({ where: { userId, createdAt: { gte: since } } }),
      prisma.aIInteraction.count({ where: { userId, createdAt: { gte: since } } }),
      prisma.aIInteraction.count({ where: { userId, createdAt: { gte: since }, status: "accepted" } }),
    ]);
    res.json({
      summary: { runs7d: runs7, aiFixes7d: fixes7, accepted7d: accepted7 },
      runs: runs.map((r) => ({ ...r, room: { id: r.room.id, title: r.room.title, language: r.room.defaultLang } })),
      aiFixes: fixes.map((f) => ({
        ...f,
        prompt: f.prompt.slice(0, 200),
        room: { id: f.room.id, title: f.room.title, language: f.room.defaultLang },
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch activity");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
