# Phase 1 — Foundation (Week 1)

Goal from the roadmap (design doc section 7): Supabase project + local Postgres in
Compose, Prisma schema, Clerk auth, rooms, roles, structured logging.

**Done when:** you can log in, create a room, and a Viewer cannot edit it.

This phase has no Yjs, no sandbox, no AI yet — it's the ground everything else stands
on. Do the steps in order; each one unblocks the next.

---

## 1. Environment & infra

- [ ] Create a Supabase project (free tier). Copy the **pooled** connection string
      (port 6543) and the **direct** connection string (port 5432).
- [ ] `cp .env.example .env` and fill in `DATABASE_URL` (pooled) and `DIRECT_URL`
      (direct) for Supabase. Leave them pointing at local Postgres for now if you'd
      rather start fully offline — switch to Supabase once Prisma migrations work locally.
- [ ] `npm run dev:infra` (or `docker compose -f infra/docker/docker-compose.yml up -d`)
      to start local Postgres, Redis, and Qdrant.
- [ ] Confirm all three containers are healthy: `docker compose -f infra/docker/docker-compose.yml ps`

## 2. Database schema

- [ ] `cd prisma && npx prisma migrate dev --name init` against local Postgres first.
- [ ] Inspect the generated tables (Supabase's table editor, or `psql`, or
      Prisma Studio: `npx prisma studio`).
- [ ] Repeat the migration against Supabase's direct URL once local migrations are clean.
- [ ] Confirm `npx prisma generate` runs without error (the API service depends on
      `@prisma/client` being generated).

## 3. Auth (Clerk)

- [ ] Create a Clerk application, grab the publishable + secret keys into `.env`.
- [ ] Wire Clerk into `apps/web` (sign-in/sign-up pages, `<ClerkProvider>`).
- [ ] Implement `services/api/src/middleware/auth.ts`: verify the Clerk JWT on every
      non-`/health` request, attach `req.user` (map Clerk user id -> your `User` row,
      creating one on first sign-in).
- [ ] Confirm a request without a token is rejected, and one with a valid token reaches
      the route handler with `req.user` populated.

## 4. Rooms & RBAC

- [ ] Implement `services/api/src/routes/rooms.ts`:
  - `POST /rooms` — create a room (hash the passcode with bcrypt/argon2 before storing;
    never store it plain), creator becomes `OWNER` in `RoomMember`.
  - `POST /rooms/:id/join` — verify passcode, add caller as `EDITOR` (or accept an
    explicit role for invited members).
  - `GET /rooms/:id` — return room + members, but only to someone in `RoomMember`.
- [ ] Add a small RBAC helper (e.g. `requireRole(["OWNER","EDITOR"])`) used by any route
      that mutates room state, so Viewer-only checks live in one place, not scattered.
- [ ] Manual test: create a room as User A, join as User B with the wrong passcode
      (rejected), join with the right one as Viewer, confirm a Viewer-only call to a
      write route is rejected server-side (not just hidden in the UI).

## 5. Structured logging

- [ ] Add a logging lib (pino or winston) to `services/api` with JSON output.
- [ ] Every request gets a `requestId` (generate if not provided, e.g. via a header),
      logged on request start/end with method, path, status, duration.
- [ ] Log auth failures and RBAC rejections at `warn` level — you'll want these later
      when debugging the sync/worker services, which should adopt the same pattern.

## 6. Smoke test

- [ ] `GET /health` returns `{ ok: true }`.
- [ ] End-to-end manual pass: sign up two users via Clerk -> User A creates a room ->
      User B joins as Editor -> User A demotes User B to Viewer -> User B's write
      request is rejected.
- [ ] Commit, push, confirm the CI skeleton (`.github/workflows/ci.yml`) at least
      installs dependencies without erroring (tests themselves come in later phases).

---

## Explicitly out of scope for Phase 1

Yjs sync, WebSockets, code execution, AI/RAG, Playwright tests, benchmarks — all of
Weeks 2 onward. Resist building ahead; Phase 1's only job is auth + rooms + roles on a
solid DB, so Week 2-3's thin end-to-end slice has something real to plug into.

## Carrying into Phase 2

- `RoomMember` role checks you wrote here get reused by the sync service's socket
  auth (design doc 2.4).
- The `requestId` logging pattern gets extended to `jobId` in the worker (design doc
  3.2) and AI service.
