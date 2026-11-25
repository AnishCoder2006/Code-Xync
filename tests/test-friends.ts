// Friends feature (services/api/src/routes/friends.ts + POST /rooms/:id/members), against the
// real Postgres with the real routers and test tokens:
//  (a) GET /friends creates a stable friend code
//  (b) request by code -> pending; incoming list + nav badge count; duplicate is idempotent
//  (c) accept; both sides see each other as friends
//  (d) two people adding each other become friends without an extra accept
//  (e) own code -> 400, unknown code -> 404, pasted full invite link works
//  (f) invite link: preview, accept -> friends at once
//  (g) add friend to room: non-friend 403, friend 201, repeat 409, viewer 403
//  (h) decline / cancel, unfriend
//  (i) "people you've coded with" suggestions
//
// Run: NODE_ENV=test npx tsx tests/test-friends.ts   (Docker Postgres up, migrations applied)

import express from "express";
import http from "http";
import { randomUUID } from "crypto";
import { prisma } from "../services/api/src/lib/prisma";
import friendsRouter from "../services/api/src/routes/friends";
import roomsRouter from "../services/api/src/routes/rooms";
import { normalizeFriendCode } from "../services/api/src/lib/friends";

if (process.env.NODE_ENV !== "test") {
  console.error("Run with NODE_ENV=test (test tokens are only accepted in test mode).");
  process.exit(1);
}

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? "\n        " + JSON.stringify(detail) : ""}`);
};

const tag = randomUUID().slice(0, 8);
const U = { ana: `user_fa_${tag}`, raj: `user_fr_${tag}`, mia: `user_fm_${tag}`, leo: `user_fl_${tag}`, zoe: `user_fz_${tag}` };
const names: Record<string, string> = { [U.ana]: "Ana Silva", [U.raj]: "Raj Patel", [U.mia]: "Mia", [U.leo]: "Leo", [U.zoe]: "Zoe" };

async function main() {
  await prisma.user.createMany({ data: Object.values(U).map((id) => ({ id, name: names[id], email: `${id}@test.local` })) });

  const app = express();
  app.use(express.json());
  app.use("/friends", friendsRouter);
  app.use("/rooms", roomsRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (uid: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer test-token-${uid}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  try {
    console.log("(a) friend code");
    const a1 = await call(U.ana, "GET", "/friends");
    const a2 = await call(U.ana, "GET", "/friends");
    const anaCode = a1.body?.me?.friendCode;
    check("GET /friends 200 with a code", a1.status === 200 && /^ana-silva-[a-z0-9]{6}$/.test(anaCode), a1.body);
    check("code is stable across calls", a2.body?.me?.friendCode === anaCode);

    console.log("(b) request by code");
    const r1 = await call(U.raj, "POST", "/friends/requests", { code: anaCode.toUpperCase() + " " });
    check("request -> 201 pending (code is case-insensitive)", r1.status === 201 && r1.body.status === "PENDING", r1);
    const r2 = await call(U.raj, "POST", "/friends/requests", { code: anaCode });
    check("duplicate request -> 200 already-requested", r2.status === 200 && r2.body.outcome === "already-requested", r2);
    const inbox = await call(U.ana, "GET", "/friends");
    check("Ana sees the incoming request", inbox.body.incoming.length === 1 && inbox.body.incoming[0].user.id === U.raj, inbox.body.incoming);
    const rajView = await call(U.raj, "GET", "/friends");
    check("Raj sees it as outgoing", rajView.body.outgoing.length === 1 && rajView.body.outgoing[0].user.id === U.ana);
    const badge = await call(U.ana, "GET", "/friends/summary");
    check("summary badge = 1", badge.body?.incoming === 1, badge.body);

    console.log("(c) accept");
    const notMine = await call(U.raj, "POST", `/friends/requests/${r1.body.id}/accept`);
    check("requester cannot accept own request -> 404", notMine.status === 404);
    const acc = await call(U.ana, "POST", `/friends/requests/${r1.body.id}/accept`);
    check("addressee accepts -> ACCEPTED", acc.status === 200 && acc.body.status === "ACCEPTED", acc);
    const both = await Promise.all([call(U.ana, "GET", "/friends"), call(U.raj, "GET", "/friends")]);
    check("both list each other as friends",
      both[0].body.friends.some((f: any) => f.id === U.raj) && both[1].body.friends.some((f: any) => f.id === U.ana));
    const again = await call(U.raj, "POST", "/friends/requests", { userId: U.ana });
    check("requesting an existing friend -> 409", again.status === 409, again);

    console.log("(d) mutual requests");
    const miaCode = (await call(U.mia, "GET", "/friends")).body.me.friendCode;
    await call(U.ana, "POST", "/friends/requests", { code: miaCode });
    const mutual = await call(U.mia, "POST", "/friends/requests", { code: anaCode });
    check("second side's request accepts the first", mutual.status === 200 && mutual.body.outcome === "accepted" && mutual.body.status === "ACCEPTED", mutual);

    console.log("(e) bad codes");
    check("own code -> 400", (await call(U.ana, "POST", "/friends/requests", { code: anaCode })).status === 400);
    check("unknown code -> 404", (await call(U.ana, "POST", "/friends/requests", { code: "nobody-zzzzzz" })).status === 404);
    check("pasted invite link resolves to the code", normalizeFriendCode(` http://localhost:3001/friends/add/${anaCode.toUpperCase()}?x=1 `) === anaCode);
    check("email lookup works (case-insensitive)",
      (await call(U.zoe, "POST", "/friends/requests", { email: `${U.leo}@TEST.local` })).status === 201);

    console.log("(f) invite link");
    const preview = await call(U.leo, "GET", `/friends/link/${anaCode}`);
    check("preview shows inviter, status none", preview.status === 200 && preview.body.user.name === "Ana Silva" && preview.body.status === "none", preview.body);
    const selfPreview = await call(U.ana, "GET", `/friends/link/${anaCode}`);
    check("own link preview -> self", selfPreview.body.status === "self");
    const viaLink = await call(U.leo, "POST", `/friends/link/${anaCode}`);
    check("accepting the link -> friends at once", viaLink.status === 200 && viaLink.body.status === "ACCEPTED", viaLink);
    check("preview now says friends", (await call(U.leo, "GET", `/friends/link/${anaCode}`)).body.status === "friends");
    check("bad link -> 404", (await call(U.leo, "POST", "/friends/link/nope-000000")).status === 404);

    console.log("(g) add friend to room");
    const room = (await call(U.ana, "POST", "/rooms", { title: `friends ${tag}` })).body;
    const stranger = await call(U.ana, "POST", `/rooms/${room.id}/members`, { userId: U.zoe });
    check("non-friend -> 403", stranger.status === 403, stranger);
    const added = await call(U.ana, "POST", `/rooms/${room.id}/members`, { userId: U.raj, role: "VIEWER" });
    check("friend -> 201 with role", added.status === 201 && added.body.role === "VIEWER" && added.body.name === "Raj Patel", added);
    check("Raj now sees the room", (await call(U.raj, "GET", "/rooms")).body.rooms.some((r: any) => r.id === room.id));
    check("adding again -> 409", (await call(U.ana, "POST", `/rooms/${room.id}/members`, { userId: U.raj })).status === 409);
    await call(U.raj, "POST", "/friends/requests", { userId: U.mia }).then((r) => call(U.mia, "POST", `/friends/requests/${r.body.id}/accept`));
    const viewerAdds = await call(U.raj, "POST", `/rooms/${room.id}/members`, { userId: U.mia });
    check("a viewer cannot add people -> 403", viewerAdds.status === 403, viewerAdds);
    check("bad role -> 400", (await call(U.ana, "POST", `/rooms/${room.id}/members`, { userId: U.mia, role: "OWNER" })).status === 400);

    console.log("(h) decline, cancel, unfriend");
    const zoeReq = await call(U.zoe, "POST", "/friends/requests", { code: anaCode });
    check("someone else cannot decline it -> 404", (await call(U.raj, "DELETE", `/friends/requests/${zoeReq.body.id}`)).status === 404);
    check("Ana declines", (await call(U.ana, "DELETE", `/friends/requests/${zoeReq.body.id}`)).status === 200);
    const zoeReq2 = await call(U.zoe, "POST", "/friends/requests", { code: anaCode });
    check("Zoe can ask again after a decline, then cancel", zoeReq2.status === 201 && (await call(U.zoe, "DELETE", `/friends/requests/${zoeReq2.body.id}`)).status === 200);
    check("unfriend Leo", (await call(U.ana, "DELETE", `/friends/${U.leo}`)).status === 200);
    check("unfriend again -> 404", (await call(U.ana, "DELETE", `/friends/${U.leo}`)).status === 404);

    console.log("(i) suggestions");
    await prisma.roomMember.create({ data: { roomId: room.id, userId: U.zoe, role: "EDITOR" } });
    const sugg = (await call(U.ana, "GET", "/friends")).body;
    check("roommate who isn't a friend is suggested", sugg.suggestions.some((s: any) => s.id === U.zoe && s.sharedRooms === 1), sugg.suggestions);
    check("existing friends are not suggested", !sugg.suggestions.some((s: any) => s.id === U.raj));
    check("friend card shows shared rooms", sugg.friends.find((f: any) => f.id === U.raj)?.sharedRooms === 1, sugg.friends);
  } finally {
    server.close();
    const ids = Object.values(U);
    await prisma.friendship.deleteMany({ where: { OR: [{ requesterId: { in: ids } }, { addresseeId: { in: ids } }] } });
    const rooms = await prisma.room.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
    await prisma.roomMember.deleteMany({ where: { OR: [{ userId: { in: ids } }, { roomId: { in: rooms.map((r) => r.id) } }] } });
    await prisma.projectFile.deleteMany({ where: { roomId: { in: rooms.map((r) => r.id) } } });
    await prisma.room.deleteMany({ where: { id: { in: rooms.map((r) => r.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
