import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { logger } from "../middleware/logger";
import { RoomRole } from "@prisma/client";
import bcrypt from "bcrypt";
import { authenticate } from "../middleware/auth";
import { ROOM_LANGUAGES, isRoomLanguage } from "../lib/languages";
import { requestReauth } from "../lib/syncControl";

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
    if (language !== undefined && !isRoomLanguage(language)) {
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

/**
 * GET /rooms/:id/history
 * Recent runs and AI fixes in this room (any member), newest first.
 */
router.get("/:id/history", requireRoomRole([]), async (req: Request, res: Response) => {
  try {
    const roomId = req.params.id;
    const [runs, fixes] = await Promise.all([
      prisma.executionLog.findMany({
        where: { roomId },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { jobId: true, status: true, runTimeMs: true, createdAt: true, stdoutTrunc: true, stderrTrunc: true, user: { select: { id: true, name: true } } },
      }),
      prisma.aIInteraction.findMany({
        where: { roomId },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, prompt: true, status: true, attempts: true, costUsd: true, createdAt: true, user: { select: { id: true, name: true } } },
      }),
    ]);
    res.json({
      runs: runs.map((r) => ({
        jobId: r.jobId,
        status: r.status,
        runTimeMs: r.runTimeMs,
        createdAt: r.createdAt,
        user: r.user,
        // A short preview only; full output stays in the terminal.
        preview: (r.stderrTrunc || r.stdoutTrunc || "").slice(0, 200),
      })),
      aiFixes: fixes.map((f) => ({ ...f, prompt: f.prompt.slice(0, 200) })),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch room history");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /rooms/:id/members/:userId  { role: "EDITOR" | "VIEWER" }
 * Owner only. The owner's own role cannot change (a room always has its owner).
 */
router.patch("/:id/members/:userId", requireRoomRole(["OWNER"]), async (req: Request, res: Response) => {
  try {
    const { role } = req.body;
    if (role !== "EDITOR" && role !== "VIEWER") {
      return res.status(400).json({ error: "role must be EDITOR or VIEWER" });
    }
    const target = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: req.params.id, userId: req.params.userId } },
    });
    if (!target) return res.status(404).json({ error: "Not a member of this room" });
    if (target.role === "OWNER") return res.status(400).json({ error: "The owner's role cannot be changed" });
    const updated = await prisma.roomMember.update({ where: { id: target.id }, data: { role } });
    await requestReauth(req.params.id, req.params.userId); // live sockets pick up the new role
    logger.info({ roomId: req.params.id, userId: req.params.userId, role, by: req.user!.id }, "Member role changed");
    res.json({ userId: updated.userId, role: updated.role });
  } catch (error) {
    logger.error({ err: error }, "Failed to change member role");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /rooms/:id/members/:userId
 * Owner removes a member, or a member leaves (userId = self). The owner cannot be removed.
 */
router.delete("/:id/members/:userId", requireRoomRole([]), async (req: Request, res: Response) => {
  try {
    const roomId = req.params.id;
    const self = req.params.userId === req.user!.id;
    const me = await prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId: req.user!.id } } });
    if (!self && me?.role !== "OWNER") return res.status(403).json({ error: "Only the owner can remove members" });
    const target = await prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId: req.params.userId } } });
    if (!target) return res.status(404).json({ error: "Not a member of this room" });
    if (target.role === "OWNER") return res.status(400).json({ error: "The owner cannot be removed" });
    await prisma.roomMember.delete({ where: { id: target.id } });
    await requestReauth(roomId, target.userId); // close their live sockets; reconnect is refused
    logger.info({ roomId, userId: target.userId, by: req.user!.id }, self ? "Member left room" : "Member removed");
    res.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to remove member");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /rooms/:id  { title?, language?, isPrivate?, passcode? }   (owner only)
 * passcode: a string sets a new one, null or "" removes it.
 */
router.patch("/:id", requireRoomRole(["OWNER"]), async (req: Request, res: Response) => {
  try {
    const { title, language, isPrivate, passcode } = req.body ?? {};
    const data: Record<string, unknown> = {};
    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim() || title.trim().length > 80) {
        return res.status(400).json({ error: "title must be 1-80 characters" });
      }
      data.title = title.trim();
    }
    if (language !== undefined) {
      if (!isRoomLanguage(language)) return res.status(400).json({ error: `language must be one of: ${ROOM_LANGUAGES.join(", ")}` });
      data.defaultLang = language;
    }
    if (isPrivate !== undefined) {
      if (typeof isPrivate !== "boolean") return res.status(400).json({ error: "isPrivate must be a boolean" });
      data.isPrivate = isPrivate;
    }
    if (passcode !== undefined) {
      if (passcode === null || passcode === "") data.passcodeHash = null;
      else if (typeof passcode === "string" && passcode.length <= 128) data.passcodeHash = await bcrypt.hash(passcode, 10);
      else return res.status(400).json({ error: "passcode must be a string (max 128) or null" });
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "Nothing to change" });
    const room = await prisma.room.update({ where: { id: req.params.id }, data, select: roomSelect });
    logger.info({ roomId: req.params.id, fields: Object.keys(data), by: req.user!.id }, "Room settings changed");
    res.json(toRoomView(room, req.user!.id));
  } catch (error) {
    logger.error({ err: error }, "Failed to update room");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /rooms/:id   (owner only)
 * Removes the room and everything recorded in it, then drops every member's live sockets.
 */
router.delete("/:id", requireRoomRole(["OWNER"]), async (req: Request, res: Response) => {
  try {
    const roomId = req.params.id;
    const members = await prisma.roomMember.findMany({ where: { roomId }, select: { userId: true } });
    await prisma.$transaction([
      prisma.aIInteraction.deleteMany({ where: { roomId } }),
      prisma.executionLog.deleteMany({ where: { roomId } }),
      prisma.codeSnapshot.deleteMany({ where: { roomId } }),
      prisma.projectFile.deleteMany({ where: { roomId } }),
      prisma.roomMember.deleteMany({ where: { roomId } }),
      prisma.room.delete({ where: { id: roomId } }),
    ]);
    await Promise.all(members.map((m) => requestReauth(roomId, m.userId)));
    logger.info({ roomId, by: req.user!.id, members: members.length }, "Room deleted");
    res.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete room");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
