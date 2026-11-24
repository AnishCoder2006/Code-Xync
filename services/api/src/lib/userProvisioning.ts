import { Prisma, type PrismaClient, type User } from "@prisma/client";

/** The fields read from a Clerk user. Google, GitHub and email/password users all fit. */
export type ClerkUserLike = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: { id: string; emailAddress: string }[];
};

/** The primary address, else the first one; null when the provider shared none (e.g. GitHub). */
export function primaryEmail(u: ClerkUserLike): string | null {
  const list = u.emailAddresses ?? [];
  const chosen = list.find((e) => e.id === u.primaryEmailAddressId) ?? list[0];
  return chosen?.emailAddress?.trim() || null;
}

export function displayName(u: ClerkUserLike): string {
  const full = [u.firstName, u.lastName].filter((p) => p && p.trim()).join(" ").trim();
  return full || u.username?.trim() || "Unknown User";
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Returns the User row for a Clerk user, creating it on first sight. Keyed on the Clerk id, so
 * repeat logins never add a row. The email is optional: it is left empty when the provider
 * gave none, or when another account already owns it (User.email is unique), instead of
 * failing the request.
 */
export async function ensureUser(db: PrismaClient, clerkUser: ClerkUserLike): Promise<User> {
  const name = displayName(clerkUser);
  let email = primaryEmail(clerkUser);
  if (email) {
    const owner = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (owner && owner.id !== clerkUser.id) email = null;
  }

  const create = (withEmail: string | null) =>
    db.user.upsert({ where: { id: clerkUser.id }, update: {}, create: { id: clerkUser.id, email: withEmail, name } });

  try {
    return await create(email);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A parallel first request created this user, or another account claimed the email meanwhile.
    const existing = await db.user.findUnique({ where: { id: clerkUser.id } });
    if (existing) return existing;
    return create(null);
  }
}
