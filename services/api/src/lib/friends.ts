import type { Friendship, PrismaClient } from "@prisma/client";

// No 0/o/1/l/i: codes are read aloud and typed from screenshots.
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** "Ana Silva" -> "ana-silva-7k3q". The suffix keeps codes unguessable enough to share openly. */
export function makeFriendCode(name: string | null | undefined, random: () => number = Math.random): string {
  const slug = (name ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 14)
    .replace(/-+$/, "");
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return slug ? `${slug}-${suffix}` : `coder-${suffix}`;
}

/** Codes are matched case-insensitively and ignore stray spaces or a pasted full link. */
export function normalizeFriendCode(input: string): string {
  const trimmed = input.trim();
  const fromLink = trimmed.match(/\/friends\/add\/([^/?#\s]+)/);
  return (fromLink ? fromLink[1] : trimmed).toLowerCase();
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "P2002";

/** The user's invite code, created on first use. */
export async function ensureFriendCode(db: PrismaClient, userId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { friendCode: true, name: true } });
  if (!user) throw new Error("User not found");
  if (user.friendCode) return user.friendCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Only fills an empty code, so a parallel first request cannot overwrite the other's.
      await db.user.updateMany({ where: { id: userId, friendCode: null }, data: { friendCode: makeFriendCode(user.name) } });
      const now = await db.user.findUnique({ where: { id: userId }, select: { friendCode: true } });
      if (now?.friendCode) return now.friendCode;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // code collision: try another
    }
  }
  throw new Error("Could not allocate a friend code");
}

/** The row linking two users, in whichever direction it was created. */
export function findFriendship(db: PrismaClient, a: string, b: string): Promise<Friendship | null> {
  return db.friendship.findFirst({
    where: { OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] },
  });
}

export async function areFriends(db: PrismaClient, a: string, b: string): Promise<boolean> {
  const row = await findFriendship(db, a, b);
  return row?.status === "ACCEPTED";
}

export type RequestOutcome =
  | { kind: "self" }
  | { kind: "already-friends"; friendship: Friendship }
  | { kind: "already-requested"; friendship: Friendship }
  | { kind: "accepted"; friendship: Friendship } // they had already asked us: now friends
  | { kind: "requested"; friendship: Friendship };

/**
 * `from` asks `to` to be friends. If `to` already asked `from`, that request is accepted
 * instead of creating a second one, so two people adding each other just become friends.
 */
export async function requestFriendship(db: PrismaClient, from: string, to: string): Promise<RequestOutcome> {
  if (from === to) return { kind: "self" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await findFriendship(db, from, to);
    if (existing?.status === "ACCEPTED") return { kind: "already-friends", friendship: existing };
    if (existing && existing.requesterId === from) return { kind: "already-requested", friendship: existing };
    if (existing) {
      const friendship = await db.friendship.update({
        where: { id: existing.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
      return { kind: "accepted", friendship };
    }
    try {
      const friendship = await db.friendship.create({ data: { requesterId: from, addresseeId: to } });
      return { kind: "requested", friendship };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // a parallel request won; look again
    }
  }
  throw new Error("Friend request conflict");
}

/** Accepting someone's invite link: become friends at once (the link is their consent). */
export async function befriendViaLink(db: PrismaClient, visitor: string, owner: string): Promise<Friendship | null> {
  if (visitor === owner) return null;
  const existing = await findFriendship(db, visitor, owner);
  if (existing?.status === "ACCEPTED") return existing;
  if (existing) {
    return db.friendship.update({ where: { id: existing.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
  }
  try {
    return await db.friendship.create({
      data: { requesterId: owner, addresseeId: visitor, status: "ACCEPTED", acceptedAt: new Date() },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return befriendViaLink(db, visitor, owner);
  }
}
