import { Router, Request, Response } from "express";
import { requireAuth } from "@clerk/express";
import { attachUser } from "../middleware/auth";
import { logger } from "../middleware/logger";
import { prisma } from "../lib/prisma";

const router = Router();
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "codesync-internal-ai-secret";

router.use(async (req: Request, res: Response, next: import("express").NextFunction) => {
  if (process.env.NODE_ENV === "test") {
    if (req.user) return next();
    const authHeader = req.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer test-token-")) {
      const uid = authHeader.replace("Bearer test-token-", "").trim();
      const user = await prisma.user.findUnique({ where: { id: uid } });
      if (user) {
        req.user = user;
        return next();
      }
    }
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

/**
 * POST /ai/fix
 * Kicks off the verified AI fix loop.
 * Captures the Yjs state vector at request time (baseVersion) so
 * the Accept endpoint can detect if the document changed while AI worked.
 * The live Yjs document is NEVER modified here.
 */
router.post("/fix", async (req: Request, res: Response) => {
  let interaction: any = null;
  try {
    const { roomId, code, prompt, language, filePath, testCommand, extraFiles } = req.body;
    if (!roomId || !code || !prompt) return res.status(400).json({ error: "Missing fields" });

    // Code size cap (100 KB)
    if (Buffer.byteLength(code, "utf8") > 100 * 1024) {
      return res.status(413).json({ error: "Code exceeds maximum allowed size of 100 KB" });
    }

    // Validate testCommand against allowlist (python3 <file>, node <file>)
    if (testCommand) {
      const parts = Array.isArray(testCommand)
        ? testCommand
        : (typeof testCommand === "string" ? testCommand.trim().split(/\s+/) : []);
      if (parts.length > 0) {
        const runner = parts[0];
        const isAllowedRunner = runner === "python3" || runner === "python" || runner === "node";
        const hasDangerousChars = parts.some((p: string) => /[;&|><$`\\]/.test(p));
        if (!isAllowedRunner || parts.length < 2 || hasDangerousChars) {
          return res.status(400).json({
            error: "Invalid testCommand: only 'python3 <file>' and 'node <file>' are allowed",
          });
        }
      }
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ── RBAC check: verify room membership and ensure user is not a VIEWER ─
    const membership = await prisma.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId,
          userId: req.user.id,
        },
      },
    });

    if (!membership) {
      logger.warn({ userId: req.user.id, roomId }, "Non-member attempted AI fix");
      return res.status(403).json({ error: "Forbidden: You are not a member of this room" });
    }

    if (membership.role === "VIEWER") {
      logger.warn({ userId: req.user.id, roomId }, "Viewer attempted AI fix");
      return res.status(403).json({ error: "Forbidden: Viewers cannot trigger AI fixes" });
    }

    // ── Daily quota check (AI_DAILY_LIMIT_PER_USER) ────────────────────────
    const dailyLimit = parseInt(process.env.AI_DAILY_LIMIT_PER_USER || "50", 10);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dailyCount = await prisma.aIInteraction.count({
      where: {
        userId: req.user.id,
        createdAt: { gte: oneDayAgo },
      },
    });

    if (dailyCount >= dailyLimit) {
      logger.warn({ userId: req.user.id, dailyCount, dailyLimit }, "Daily AI quota exceeded");
      return res.status(429).json({ error: "Daily AI interaction quota exceeded" });
    }

    // ── Capture the current Yjs state vector as the base version ──────────
    // This is used later in PATCH /:id/accept to detect concurrent edits.
    const syncServiceUrl = process.env.SYNC_SERVICE_URL || "http://localhost:4001";
    let baseVersion = "latest"; // fallback for Phase 2 compatibility
    let baseText = code;        // the frontend sends the current file snapshot
    try {
      const stateRes = await fetch(`${syncServiceUrl}/room/${roomId}/state`, {
        headers: { "x-internal-secret": INTERNAL_SECRET },
        signal: AbortSignal.timeout(3000),
      });
      if (stateRes.ok) {
        const stateData = await stateRes.json() as { stateVector?: string; content?: string };
        if (stateData.stateVector) baseVersion = stateData.stateVector;
        if (stateData.content)    baseText    = stateData.content;
      }
    } catch (svErr) {
      logger.warn({ svErr, roomId }, "Could not fetch state vector; using 'latest' as baseVersion");
    }

    // Record the interaction immediately as pending
    interaction = await prisma.aIInteraction.create({
      data: {
        roomId,
        userId: req.user.id,
        prompt,
        baseVersion,  // real Yjs state vector (or "latest" fallback)
        status: "pending",
      },
    });

    // Call AI service over REST (Phase 5: real LangGraph agent)
    const aiServiceUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
    const aiRes = await fetch(`${aiServiceUrl}/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_id: roomId,
        user_id: req.user.id,
        prompt,
        code: baseText,
        language: language || "python",
        file_path: filePath || "main.py",
        base_version: baseVersion,
        test_command: testCommand || [],
        extra_files: extraFiles || req.body.extra_files || {},
      }),
    });

    if (!aiRes.ok) {
      await prisma.aIInteraction.update({
        where: { id: interaction.id },
        data: { status: "failed" },
      });
      throw new Error(`AI service failed: ${aiRes.statusText}`);
    }

    const data = await aiRes.json() as {
      status: string;
      patch: string;
      patched_text?: string;
      function_name?: string;
      original_code?: string;
      new_code?: string;
      start_line?: number;
      end_line?: number;
      error_message?: string;
      llm_calls?: number;
      total_cost_usd?: number;
    };

    // Update the interaction with result
    await prisma.aIInteraction.update({
      where: { id: interaction.id },
      data: {
        status: data.status,
        diffPatch: data.patch,   // unified diff; stored for Accept replay
      },
    });

    // Return interaction id so the frontend can call PATCH /ai/:id/accept
    return res.json({ ...data, interactionId: interaction.id });

  } catch (err) {
    logger.error({ err }, "Failed AI fix request");
    if (interaction?.id) {
      await prisma.aIInteraction.update({
        where: { id: interaction.id },
        data: { status: "failed" },
      }).catch(() => {});
    }
    return res.status(500).json({ error: "Internal error" });
  }
});

/**
 * PATCH /ai/:id/accept
 * Human accepts the diff. Performs a stale-version check then applies the
 * patch to the live Yjs document via the sync service's /apply-patch endpoint.
 *
 * Design doc section 5.3:
 *   "Only a human clicking Accept, after a stale-version check, changes the live doc."
 */
router.patch("/:id/accept", async (req: Request, res: Response) => {
  try {
    const interaction = await prisma.aIInteraction.findUnique({
      where: { id: req.params.id },
    });

    if (!interaction) return res.status(404).json({ error: "Interaction not found" });

    // RBAC: Verify room membership and ensure user is OWNER or EDITOR
    const membership = await prisma.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId: interaction.roomId,
          userId: req.user!.id,
        },
      },
    });

    if (!membership || membership.role === "VIEWER") {
      logger.warn({ userId: req.user!.id, roomId: interaction.roomId, role: membership?.role }, "RBAC rejection on AI interaction accept");
      return res.status(403).json({ error: "Forbidden: Only room OWNER or EDITOR can accept AI fixes" });
    }

    // Status check: accept only from verified or unverified_no_test
    if (interaction.status !== "verified" && interaction.status !== "unverified_no_test") {
      return res.status(409).json({
        error: `Cannot accept interaction with status '${interaction.status}'. Only 'verified' or 'unverified_no_test' interactions can be accepted.`,
      });
    }

    // ── Stale check: oldRangeText still present exactly once ───────────────
    const { oldRangeText, newCode, startOffset, deleteLength } = req.body;
    const syncServiceUrl = process.env.SYNC_SERVICE_URL || "http://localhost:4001";

    if (oldRangeText) {
      let currentContent: string | null = null;
      try {
        const textRes = await fetch(
          `${syncServiceUrl}/room/${interaction.roomId}/text`,
          {
            headers: { "x-internal-secret": INTERNAL_SECRET },
            signal: AbortSignal.timeout(3000),
          }
        );
        if (!textRes.ok) {
          logger.error({ status: textRes.status }, "Sync service text fetch failed");
          return res.status(503).json({ error: "Sync service unavailable for stale check" });
        }
        const textData = await textRes.json() as { content?: string };
        currentContent = textData.content ?? null;
      } catch (err) {
        logger.error({ err }, "Could not fetch current document text for stale check");
        return res.status(503).json({ error: "Sync service unavailable for stale check" });
      }

      if (currentContent === null) {
        return res.status(503).json({ error: "Sync service returned null document content" });
      }

      const occurrences = currentContent.split(oldRangeText).length - 1;
      if (occurrences === 0 || occurrences > 1) {
        await prisma.aIInteraction.update({
          where: { id: req.params.id },
          data: { status: "stale" },
        });
        logger.warn(
          { interactionId: req.params.id, roomId: interaction.roomId, occurrences },
          "Stale AI fix rejected"
        );
        return res.status(409).json({
          error: occurrences === 0
            ? "File changed while AI was working: target function was modified. Please regenerate the fix."
            : "Ambiguous match: target function code appears multiple times in document.",
          stale: true,
        });
      }
    }

    // ── Apply the patch to the live Yjs document via sync service ─────────
    const applyRes = await fetch(
      `${syncServiceUrl}/room/${interaction.roomId}/apply-patch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": INTERNAL_SECRET,
        },
        body: JSON.stringify({
          startOffset: typeof startOffset === "number" ? startOffset : undefined,
          deleteLength: typeof deleteLength === "number" ? deleteLength : undefined,
          oldRangeText: oldRangeText ?? undefined,
          newCode: newCode ?? req.body.new_code ?? "",
          baseVersion: interaction.baseVersion,
        }),
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!applyRes.ok) {
      if (applyRes.status === 409) {
        await prisma.aIInteraction.update({
          where: { id: req.params.id },
          data: { status: "stale" },
        }).catch(() => {});
      }
      const errBody = await applyRes.text();
      logger.error({ status: applyRes.status, errBody }, "Sync service apply-patch failed");
      return res.status(applyRes.status === 400 ? 409 : applyRes.status).json({
        error: "Failed to apply patch to document: conflict or modified range",
        stale: true,
      });
    }

    // Success sets status to "accepted"
    const updated = await prisma.aIInteraction.update({
      where: { id: req.params.id },
      data: { status: "accepted" },
    });

    return res.json(updated);
  } catch (err) {
    logger.error({ err }, "Failed to accept AI interaction");
    return res.status(500).json({ error: "Internal error" });
  }
});

/**
 * PATCH /ai/:id
 * Called by the frontend for reject only.
 * Accepts must use PATCH /ai/:id/accept with stale check and Yjs patch.
 */
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (status !== "rejected") {
      return res.status(400).json({
        error: "Only status 'rejected' is allowed on this endpoint. Use PATCH /ai/:id/accept to accept.",
      });
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
