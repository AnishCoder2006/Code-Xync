// User rows created from Clerk logins (services/api/src/lib/userProvisioning.ts), against the
// real Postgres:
//  (a) Google-style payload: primary email and full name stored
//  (b) GitHub-style payload with no email: row created, email NULL, username as name
//  (c) second login with the same Clerk id: same row, no duplicate
//  (d) a different Clerk account with an email already taken: no unique-constraint error
//  (e) five parallel first requests for one new user: one row, no error
//
// Run: npx tsx tests/test-user-provisioning.ts   (Docker Postgres up, migrations applied)

import { randomUUID } from "crypto";
import { prisma } from "../services/api/src/lib/prisma";
import { ensureUser, type ClerkUserLike } from "../services/api/src/lib/userProvisioning";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? "\n        " + JSON.stringify(detail) : ""}`);
};

const tag = randomUUID().slice(0, 8);
const ids = { google: `user_g_${tag}`, github: `user_gh_${tag}`, other: `user_o_${tag}`, race: `user_r_${tag}` };
const googleEmail = `ana.${tag}@gmail.test`;

const google: ClerkUserLike = {
  id: ids.google,
  firstName: "Ana",
  lastName: "Silva",
  username: null,
  primaryEmailAddressId: "idn_primary",
  emailAddresses: [
    { id: "idn_secondary", emailAddress: `ana.work.${tag}@corp.test` },
    { id: "idn_primary", emailAddress: googleEmail },
  ],
};
const github: ClerkUserLike = {
  id: ids.github,
  firstName: null,
  lastName: null,
  username: `rajp-${tag}`,
  primaryEmailAddressId: null,
  emailAddresses: [],
};

async function main() {
  try {
    console.log("(a) Google-style payload");
    const a = await ensureUser(prisma, google);
    check("row keyed on the Clerk id", a.id === ids.google, a);
    check("primary email stored (not the first address)", a.email === googleEmail, a.email);
    check("full name stored", a.name === "Ana Silva", a.name);

    console.log("(b) GitHub-style payload, no email");
    const b = await ensureUser(prisma, github);
    check("row created", b.id === ids.github, b);
    check("email is NULL", b.email === null, b.email);
    check("username used as name", b.name === `rajp-${tag}`, b.name);

    console.log("(c) second login with the same Clerk id");
    const a2 = await ensureUser(prisma, { ...google, firstName: "Ana Maria" });
    const b2 = await ensureUser(prisma, github);
    check("same row returned (Google)", a2.id === a.id && a2.createdAt.getTime() === a.createdAt.getTime(), a2);
    check("same row returned (GitHub)", b2.id === b.id, b2);
    const rows = await prisma.user.count({ where: { id: { in: [ids.google, ids.github] } } });
    check("no duplicate rows (2 users -> 2 rows)", rows === 2, rows);

    console.log("(d) another Clerk account with an email that is already taken");
    let threw: unknown = null;
    let d = null;
    try {
      d = await ensureUser(prisma, { id: ids.other, firstName: "Ana", lastName: "S", emailAddresses: [{ id: "x", emailAddress: googleEmail }], primaryEmailAddressId: "x" });
    } catch (err) {
      threw = err;
    }
    check("no unique-constraint error", threw === null, String(threw));
    check("row created with email left empty", d?.id === ids.other && d?.email === null, d);
    const owner = await prisma.user.findUnique({ where: { email: googleEmail } });
    check("original owner keeps the email", owner?.id === ids.google, owner?.id);

    console.log("(e) five parallel first requests for one new user");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ensureUser(prisma, { id: ids.race, firstName: "Mo", emailAddresses: [{ id: "m", emailAddress: `mo.${tag}@x.test` }], primaryEmailAddressId: "m" }))
    );
    check("all five succeed", results.every((r) => r.status === "fulfilled"), results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)));
    check("exactly one row", (await prisma.user.count({ where: { id: ids.race } })) === 1);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } }).catch(() => {});
  process.exit(1);
});
