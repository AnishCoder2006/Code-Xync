import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { logger } from "../middleware/logger";
import { RoomRole } from "@prisma/client";
import bcrypt from "bcrypt";
import { requireAuth } from "@clerk/express";
import { attachUser } from "../middleware/auth";

const router = Router();

// Small RBAC helper for room access
export const requireRoomRole = (allowedRoles: RoomRole[]) => {
  return async (req: Request, res: Response, next: import("express").NextFunction) => {
    try {
      if (!req.user) {
        logger.warn("Unauthenticated room access attempt");
        return res.status(401).json({ error: "Unauthorized" });
      }

      const roomId = req.params.id;
      if (!roomId) return res.status(400).json({ error: "Room ID required" });

      const member = await prisma.roomMember.findUnique({
        where: {
          roomId_userId: {
            roomId,
            userId: req.user.id
          }
        }
      });

      if (!member) {
        logger.warn({ userId: req.user.id, roomId }, "User is not a member of the room");
        return res.status(403).json({ error: "Forbidden" });
      }

      if (allowedRoles.length > 0 && !allowedRoles.includes(member.role as RoomRole)) {
        logger.warn({ userId: req.user.id, role: member.role, roomId }, "Room RBAC rejection");
        return res.status(403).json({ error: "Forbidden" });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

router.use(requireAuth());
router.use(attachUser);

router.post("/", async (req: Request, res: Response) => {
  try {
    const { title, passcode } = req.body;
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    let passcodeHash = null;
    if (passcode) {
      passcodeHash = await bcrypt.hash(passcode, 10);
    }

    const room = await prisma.room.create({
      data: {
        title: title || "Untitled Room",
        passcodeHash,
        ownerId: req.user.id,
        members: {
          create: {
            userId: req.user.id,
            role: "OWNER"
          }
        }
      },
      include: { members: true }
    });

    res.json(room);
  } catch (error) {
    logger.error({ err: error }, "Failed to create room");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/join", async (req: Request, res: Response) => {
  try {
    const { passcode } = req.body;
    const roomId = req.params.id;
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) return res.status(404).json({ error: "Room not found" });

    if (room.passcodeHash) {
      if (!passcode) return res.status(401).json({ error: "Passcode required" });
      const valid = await bcrypt.compare(passcode, room.passcodeHash);
      if (!valid) {
        logger.warn({ userId: req.user.id, roomId }, "Invalid passcode attempt");
        return res.status(401).json({ error: "Invalid passcode" });
      }
    }

    const member = await prisma.roomMember.upsert({
      where: { roomId_userId: { roomId, userId: req.user.id } },
      update: {},
      create: { roomId, userId: req.user.id, role: "EDITOR" }
    });

    res.json(member);
  } catch (error) {
    logger.error({ err: error }, "Failed to join room");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", requireRoomRole([]), async (req: Request, res: Response) => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: req.params.id },
      include: { members: true }
    });
    res.json(room);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch room");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
