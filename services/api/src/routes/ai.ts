import { Router, Request, Response } from "express";
import { requireAuth } from "@clerk/express";
import { attachUser } from "../middleware/auth";
import { logger } from "../middleware/logger";
import { prisma } from "../lib/prisma";

const router = Router();

router.use((req: Request, res: Response, next: import("express").NextFunction) => {
  if (process.env.NODE_ENV === "test" && req.user) {
    return next();
  }
  return requireAuth()(req, res, () => attachUser(req, res, next));
});

/**
 * POST /search (or /ai/search)
 * Hybrid code search. Verifies RoomMember first, then proxies to AI service.
 * The browser never calls the AI service directly.
 */
router.post("/search", async (req: Request, res: Response) => {
  try {
    const { roomId, query, limit } = req.body;
    if (!roomId || !query) {
      return res.status(400).json({ error: "Missing required fields: roomId and query" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Verify user is a member of this room (OWNER, EDITOR, or VIEWER)
    const membership = await prisma.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId,
          userId: req.user.id,
        },
      },
    });

    if (!membership) {
      logger.warn({ userId: req.user.id, roomId }, "Non-member attempted code search");
      return res.status(403).json({ error: "Forbidden: You are not a member of this room" });
    }

    // Call AI service over REST
    const aiServiceUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
    const aiRes = await fetch(`${aiServiceUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId,
        query,
        limit: limit ? Number(limit) : 10,
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      logger.error({ status: aiRes.status, errBody }, "AI search service failed");
      return res.status(aiRes.status).json({ error: "AI search service failed" });
    }

    const data = await aiRes.json();
    return res.json(data);
  } catch (err) {
    logger.error({ err }, "Failed code search request");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/fix", async (req: Request, res: Response) => {
  try {
    const { roomId, code, prompt, language } = req.body;
    if (!roomId || !code || !prompt) return res.status(400).json({ error: "Missing fields" });

    // Record the interaction immediately as pending
    const interaction = await prisma.aIInteraction.create({
      data: {
        roomId,
        userId: req.user!.id,
        prompt,
        baseVersion: "latest", // Yjs state vector – simplified for Phase 2
        status: "pending",
      },
    });

    // Call AI service over REST
    const aiServiceUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
    const aiRes = await fetch(`${aiServiceUrl}/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_id: roomId,
        user_id: req.user!.id,
        prompt,
        code,
        language
      })
    });

    if (!aiRes.ok) {
      await prisma.aIInteraction.update({
        where: { id: interaction.id },
        data: { status: "failed" }
      });
      throw new Error(`AI service failed: ${aiRes.statusText}`);
    }

    const data = await aiRes.json();

    // Update the interaction with result
    await prisma.aIInteraction.update({
      where: { id: interaction.id },
      data: {
        status: data.status,
        diffPatch: data.patch, // AI service returns 'patch'; schema field is diffPatch
      },
    });

    // Return interaction id so the frontend can call PATCH /ai/:id on Accept/Reject
    res.json({ ...data, interactionId: interaction.id });

  } catch (err) {
    logger.error({ err }, "Failed AI fix request");
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /ai/:id — called by the frontend when the user accepts or rejects a diff.
// Both paths must be audited; never let a Reject be a silent local state reset.
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { status } = req.body; // "verified" | "rejected"
    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be 'verified' or 'rejected'" });
    }

    const interaction = await prisma.aIInteraction.findUnique({
      where: { id: req.params.id },
    });

    if (!interaction) return res.status(404).json({ error: "Interaction not found" });
    if (interaction.userId !== req.user!.id) {
      logger.warn({ userId: req.user!.id, interactionId: req.params.id }, "RBAC rejection on AI interaction update");
      return res.status(403).json({ error: "Forbidden" });
    }

    const updated = await prisma.aIInteraction.update({
      where: { id: req.params.id },
      data: { status },
    });

    res.json(updated);
  } catch (err) {
    logger.error({ err }, "Failed to update AI interaction status");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
