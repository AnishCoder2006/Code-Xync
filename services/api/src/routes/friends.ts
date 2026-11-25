import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { logger } from "../middleware/logger";
import { authenticate } from "../middleware/auth";
import {
  befriendViaLink,
  ensureFriendCode,
  findFriendship,
  normalizeFriendCode,
  requestFriendship,
} from "../lib/friends";

/**
 * Friends: personal invite links, friend requests, and "people you've coded with".
 *
 *   GET    /friends                      everything the Friends page shows
 *   GET    /friends/summary              { incoming } for the nav badge
 *   POST   /friends/requests             { code } | { userId } | { email }
 *   POST   /friends/requests/:id/accept  addressee accepts
 *   DELETE /friends/requests/:id         addressee declines / requester cancels
 *   GET    /friends/link/:code           preview an invite link
 *   POST   /friends/link/:code           accept an invite link (friends at once)
 *   DELETE /friends/:userId              unfriend
 */
const router = Router();
router.use(authenticate);

type Person = { id: string; name: string | null };
const person = (u: Person) => ({ id: u.id, name: u.name ?? "Unnamed coder" });
const fail = (res: Response, err: unknown, msg: string) => {
  logger.error({ err }, msg);
  res.status(500).json({ error: "Internal server error" });
};

router.get("/", async (req: Request, res: Response) => {
  try {
    const me = req.user!.id;
    const [friendCode, rows, myRooms] = await Promise.all([
      ensureFriendCode(prisma, me),
      prisma.friendship.findMany({
        where: { OR: [{ requesterId: me }, { addresseeId: me }] },
        include: { requester: { select: { id: true, name: true } }, addressee: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.roomMember.findMany({ where: { userId: me }, select: { roomId: true } }),
    ]);

    // How many rooms I share with each person (drives both the friend cards and suggestions).
    const shared = new Map<string, number>();
    if (myRooms.length > 0) {
      const co = await prisma.roomMember.groupBy({
        by: ["userId"],
        where: { roomId: { in: myRooms.map((r) => r.roomId) }, userId: { not: me } },
        _count: { _all: true },
      });
      co.forEach((c) => shared.set(c.userId, c._count._all));
    }

    const other = (r: (typeof rows)[number]) => (r.requesterId === me ? r.addressee : r.requester);
    const accepted = rows.filter((r) => r.status === "ACCEPTED");
    const friendIds = accepted.map((r) => other(r).id);
    const lastRuns = friendIds.length
      ? await prisma.executionLog.groupBy({ by: ["userId"], where: { userId: { in: friendIds } }, _max: { createdAt: true } })
      : [];
    const lastRun = new Map(lastRuns.map((r) => [r.userId, r._max.createdAt]));

    const known = new Set(rows.map((r) => other(r).id));
    const candidates = [...shared.entries()].filter(([id]) => !known.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const candidateUsers = candidates.length
      ? await prisma.user.findMany({ where: { id: { in: candidates.map(([id]) => id) } }, select: { id: true, name: true } })
      : [];
    const byId = new Map(candidateUsers.map((u) => [u.id, u]));

    res.json({
      me: { id: me, friendCode },
      friends: accepted
        .map((r) => {
          const u = other(r);
          return { ...person(u), since: r.acceptedAt ?? r.createdAt, sharedRooms: shared.get(u.id) ?? 0, lastRunAt: lastRun.get(u.id) ?? null };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
      incoming: rows
        .filter((r) => r.status === "PENDING" && r.addresseeId === me)
        .map((r) => ({ id: r.id, user: person(r.requester), sharedRooms: shared.get(r.requesterId) ?? 0, createdAt: r.createdAt })),
      outgoing: rows
        .filter((r) => r.status === "PENDING" && r.requesterId === me)
        .map((r) => ({ id: r.id, user: person(r.addressee), createdAt: r.createdAt })),
      suggestions: candidates
        .filter(([id]) => byId.has(id))
        .map(([id, sharedRooms]) => ({ ...person(byId.get(id)!), sharedRooms })),
    });
  } catch (err) {
    fail(res, err, "Failed to load friends");
  }
});

router.get("/summary", async (req: Request, res: Response) => {
  try {
    const incoming = await prisma.friendship.count({ where: { addresseeId: req.user!.id, status: "PENDING" } });
    res.json({ incoming });
  } catch (err) {
    fail(res, err, "Failed to load friends summary");
  }
});

router.post("/requests", async (req: Request, res: Response) => {
  try {
    const me = req.user!.id;
    const { code, userId, email } = req.body ?? {};
    let target: Person | null = null;
    if (typeof code === "string" && code.trim()) {
      target = await prisma.user.findUnique({ where: { friendCode: normalizeFriendCode(code) }, select: { id: true, name: true } });
      if (!target) return res.status(404).json({ error: "No one has that friend code. Check it and try again." });
    } else if (typeof email === "string" && email.trim()) {
      target = await prisma.user.findFirst({
        where: { email: { equals: email.trim(), mode: "insensitive" } },
        select: { id: true, name: true },
      });
      if (!target) return res.status(404).json({ error: "No CodeSync account uses that email. Send them your invite link instead." });
    } else if (typeof userId === "string" && userId) {
      target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
      if (!target) return res.status(404).json({ error: "That person no longer has an account." });
    } else {
      return res.status(400).json({ error: "Send a friend code, an email, or a userId." });
    }

    const outcome = await requestFriendship(prisma, me, target.id);
    if (outcome.kind === "self") return res.status(400).json({ error: "That's your own code. Share it with a friend instead." });
    if (outcome.kind === "already-friends") return res.status(409).json({ error: `You and ${person(target).name} are already friends.` });
    logger.info({ from: me, to: target.id, outcome: outcome.kind }, "Friend request");
    res.status(outcome.kind === "requested" ? 201 : 200).json({
      id: outcome.friendship.id,
      status: outcome.friendship.status,
      outcome: outcome.kind,
      user: person(target),
    });
  } catch (err) {
    fail(res, err, "Failed to send friend request");
  }
});

router.post("/requests/:id/accept", async (req: Request, res: Response) => {
  try {
    const row = await prisma.friendship.findUnique({ where: { id: req.params.id } });
    if (!row || row.addresseeId !== req.user!.id) return res.status(404).json({ error: "Friend request not found" });
    if (row.status === "ACCEPTED") return res.json({ id: row.id, status: row.status });
    const updated = await prisma.friendship.update({ where: { id: row.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
    res.json({ id: updated.id, status: updated.status });
  } catch (err) {
    fail(res, err, "Failed to accept friend request");
  }
});

router.delete("/requests/:id", async (req: Request, res: Response) => {
  try {
    const me = req.user!.id;
    const row = await prisma.friendship.findUnique({ where: { id: req.params.id } });
    if (!row || row.status !== "PENDING" || (row.addresseeId !== me && row.requesterId !== me)) {
      return res.status(404).json({ error: "Friend request not found" });
    }
    await prisma.friendship.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Failed to remove friend request");
  }
});

const linkOwner = (code: string) =>
  prisma.user.findUnique({ where: { friendCode: normalizeFriendCode(code) }, select: { id: true, name: true } });

router.get("/link/:code", async (req: Request, res: Response) => {
  try {
    const owner = await linkOwner(req.params.code);
    if (!owner) return res.status(404).json({ error: "This invite link doesn't work any more. Ask your friend for a new one." });
    const me = req.user!.id;
    const row = owner.id === me ? null : await findFriendship(prisma, me, owner.id);
    const status = owner.id === me ? "self" : row?.status === "ACCEPTED" ? "friends" : row ? "pending" : "none";
    res.json({ user: person(owner), status });
  } catch (err) {
    fail(res, err, "Failed to read invite link");
  }
});

router.post("/link/:code", async (req: Request, res: Response) => {
  try {
    const owner = await linkOwner(req.params.code);
    if (!owner) return res.status(404).json({ error: "This invite link doesn't work any more. Ask your friend for a new one." });
    if (owner.id === req.user!.id) return res.status(400).json({ error: "This is your own invite link. Send it to a friend." });
    await befriendViaLink(prisma, req.user!.id, owner.id);
    logger.info({ visitor: req.user!.id, owner: owner.id }, "Friend added via invite link");
    res.json({ status: "ACCEPTED", user: person(owner) });
  } catch (err) {
    fail(res, err, "Failed to accept invite link");
  }
});

router.delete("/:userId", async (req: Request, res: Response) => {
  try {
    const row = await findFriendship(prisma, req.user!.id, req.params.userId);
    if (!row || row.status !== "ACCEPTED") return res.status(404).json({ error: "You're not friends with this person" });
    await prisma.friendship.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Failed to remove friend");
  }
});

export default router;
