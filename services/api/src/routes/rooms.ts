import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { logger } from "../middleware/logger";
import { RoomRole } from "@prisma/client";
import bcrypt from "bcrypt";
import { authenticate } from "../middleware/auth";

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

export const ROOM_LANGUAGES = ["python", "javascript"] as const;

// Never return passcodeHash; members carry only id, name and role.
const roomSelect = {
  id: true,
  title: true,
  defaultLang: true,
  isPrivate: true,
  ownerId: true,
  createdAt: true,
  passcodeHash: true, // read to compute hasPasscode, stripped by toRoomView
  members: {
    select: { userId: true, role: true, joinedAt: true, user: { select: { name: true } } },
    orderBy: { joinedAt: "asc" as const },
  },
};

type RoomRow = {
  id: string; title: string; defaultLang: string; isPrivate: boolean; ownerId: string; createdAt: Date;
  passcodeHash: string | null;
  members: { userId: string; role: RoomRole; joinedAt: Date; user: { name: string | null } }[];
};

const toRoomView = (room: RoomRow, viewerId: string) => {
  const { passcodeHash, members, ...rest } = room;
  return {
    ...rest,
    language: room.defaultLang,
    hasPasscode: passcodeHash !== null,
    myRole: members.find((m) => m.userId === viewerId)?.role ?? null,
    members: members.map((m) => ({ userId: m.userId, name: m.user.name, role: m.role, joinedAt: m.joinedAt })),
  };
};

router.use(authenticate);

/**
 * GET /rooms
 * Rooms the caller is a member of, most recently updated first.
 * lastUpdatedAt = newest ProjectFile.updatedAt (written on every sync save), else room creation time.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const memberships = await prisma.roomMember.findMany({
      where: { userId: req.user.id },
      select: {
        role: true,
        joinedAt: true,
        room: {
          select: {
            id: true,
            title: true,
            defaultLang: true,
            isPrivate: true,
            ownerId: true,
            createdAt: true,
            passcodeHash: true,
            files: { select: { updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 },
            _count: { select: { members: true } },
          },
        },
      },
    });

    const rooms = memberships
      .map(({ role, joinedAt, room }) => ({
        id: room.id,
        title: room.title,
        language: room.defaultLang,
        isPrivate: room.isPrivate,
        hasPasscode: room.passcodeHash !== null,
        ownerId: room.ownerId,
        role,
        joinedAt,
        memberCount: room._count.members,
        createdAt: room.createdAt,
        lastUpdatedAt: room.files[0]?.updatedAt ?? room.createdAt,
      }))
      .sort((a, b) => b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime());

    res.json({ rooms });
  } catch (error) {
    logger.error({ err: error }, "Failed to list rooms");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const { title, passcode, language, isPrivate } = req.body;
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (language !== undefined && !ROOM_LANGUAGES.includes(language)) {
      return res.status(400).json({ error: `language must be one of: ${ROOM_LANGUAGES.join(", ")}` });
    }
    if (isPrivate !== undefined && typeof isPrivate !== "boolean") {
      return res.status(400).json({ error: "isPrivate must be a boolean" });
    }
    if (passcode !== undefined && passcode !== null && passcode !== "" && typeof passcode !== "string") {
      return res.status(400).json({ error: "passcode must be a string" });
    }

    let passcodeHash = null;
    if (passcode) {
      passcodeHash = await bcrypt.hash(passcode, 10);
    }

    const room = await prisma.room.create({
      data: {
        title: (typeof title === "string" && title.trim()) || "Untitled Room",
        passcodeHash,
        ownerId: req.user.id,
        ...(language !== undefined ? { defaultLang: language } : {}),
        ...(isPrivate !== undefined ? { isPrivate } : {}),
        members: {
          create: {
            userId: req.user.id,
            role: "OWNER"
          }
        }
      },
      select: roomSelect,
    });

    res.json(toRoomView(room, req.user.id));
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
      select: roomSelect,
    });
    if (!room) return res.status(404).json({ error: "Room not found" });
    res.json(toRoomView(room, req.user!.id));
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch room");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
