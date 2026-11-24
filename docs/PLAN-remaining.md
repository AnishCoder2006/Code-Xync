# CodeSync — plan for the remaining work

Status on 2026-11-24 (commit `7c8c528` on `main`): Weeks 1–11 are implemented and Phase 6
measurement is recorded (`README.md` Results, `docs/PROGRESS.md`). This plan covers what is
left: the **full product frontend** and **Week 12 "Ship"** from
`docs/codesync-implementation-plan-v4.pdf` §7.

Decisions already made by the owner:
- **Auth:** real Clerk. The owner adds the keys; nothing here reads or searches for them.
- **Frontend scope:** full product UI (option "Full product UI").
- **Demo video:** script only. The owner records the video.

## Working rules (apply to every step)
- Run everything; paste real output and exit codes. Never invent or round numbers.
- Never search the disk or environment for credentials.
- After each step, append one line to `docs/PROGRESS.md` (step, status, proving command).
- Test only new or changed work; do not re-run suites that already passed unless their code changed.
- A missed target is reported as missed, not tuned away.
- Before Docker-heavy work, time `docker ps` and one container start; if Docker is slow
  (machine near its memory commit limit), ask the owner to free memory first.
- Commit and push only when the owner asks; branch first, never force-push.

---

## Part 1 · Backend support the UI needs

| # | Step | Done when | Proof |
|---|---|---|---|
| 1.1 | `GET /rooms`: rooms the user belongs to (title, language, role, last updated), RBAC-scoped | returns only the caller's rooms; 401 without auth | new API test (test token) |
| 1.2 | AI progress streaming. Client sends a `progressId` with `POST /ai/fix`; the AI service publishes steps (`context`, `generating`, `applying`, `testing`, `retrying n`, `done`/`failed`) to Redis `ai:progress:<progressId>`; API exposes `GET /ai/progress/:progressId` as SSE, auth + room-membership checked. Existing `/ai/fix` response shape stays the same. | a client subscribed before the request sees every step in order, then `done` | new test: mock provider (`mixed` scenario) → events include a retry |
| 1.3 | Room metadata for the header: `GET /rooms/:id` already exists; add member list with roles | viewer sees own role | API test |

## Part 2 · Frontend (Next.js pages router, `apps/web`)

Design (changed by the owner on 2026-11-24, was "CSS Modules, no UI framework"): **shadcn/ui**
(Tailwind 3.4 + Radix primitives, components copied into `apps/web/src/components/ui`), own
palette (teal primary, amber highlight, warm paper / deep green-slate neutrals, no purple),
signature backdrop (dot grid + teal/amber glows) outside the editor, light and dark. Every
screen has loading, empty and error states.

| # | Step | Done when |
|---|---|---|
| 2.1 | **Layout:** top bar with logo, nav, Clerk `UserButton`; signed-out landing page with sign-in / sign-up (Clerk components) | signed-out users see the landing page; protected routes redirect to sign-in |
| 2.2 | **Dashboard `/rooms`:** my rooms (from 1.1), create room (title, language, private + optional passcode), join by room ID (+ passcode) | create → lands in the new room; join → added as member; errors shown inline |
| 2.3 | **Room page `/room/[id]`:** header (title, language, copy-invite, connection pill connected / reconnecting / offline from the provider status), Monaco editor | two users edit and converge (covered by existing sync tests) |
| 2.4 | **Presence:** avatars of everyone in the room (Yjs awareness, name + colour from the Clerk user), named coloured remote cursors and selections (y-monaco classes) | two browsers show each other's avatar and cursor; avatar disappears on leave |
| 2.5 | **Viewer read-only:** role `VIEWER` → Monaco read-only, Run / AI buttons disabled with a reason (plan Week 1 "Viewer cannot edit") | viewer cannot type; server still enforces it |
| 2.6 | **Run + terminal:** Run button, xterm panel streaming stdout/stderr, exit status, clear "busy, retry" for 503 and rate-limit (429, with retry-after) messages | output streams; 429/503 show readable messages |
| 2.7 | **AI fix panel (`AIDiffPanel`, replaces the stub):** prompt box → live progress steps (from 1.2) → side-by-side diff → Accept / Reject; attempts and cost shown; stale patch → "file changed while the AI was working, regenerate" | mock-provider run shows progress, diff, Accept updates both editors; stale case shows the message |

**Auth in tests.** Real pages use Clerk. For automated tests the E2E build
(`NEXT_PUBLIC_E2E=1`) swaps the auth hook for a test-token implementation through a
build-time alias, the same way `/e2e/editor` is excluded today. The production-build check
(`tests/test-a4-prod-404.ts`) is extended: no test-auth code in the production bundle.

**Tests (Playwright, real browser, E2E build, mock LLM):**
- dashboard: create, list, join (two users)
- room: Run shows output; 429 message
- presence: avatars + remote cursor between two browsers
- viewer is read-only
- AI panel: progress steps appear in order, diff shown, Accept updates both editors on two
  nodes; stale patch message
- run the UI suite 3 times in a row (retries 0) and record results like
  `benchmarks/results/a2-browser-suite.json`
- `next build` (production) passes; extended A4 check passes

Owner's manual check once keys are in `.env`: sign up, create a room, open it in a second
browser profile, edit together, Run, AI fix with a real provider.

## Part 3 · Week 12 "Ship"

| # | Step | Done when | Proof |
|---|---|---|---|
| 3.1 | **Compose + Nginx deploy** (`infra/docker/docker-compose.prod.yml`): web (Next standalone), api, sync1 + sync2, worker, ai, redis, qdrant, postgres (local profile; Supabase optional), a one-shot `prisma migrate deploy` service, healthchecks; Nginx routes `/` → web, `/api/` → api, `/sync/` → both sync nodes (WebSocket upgrade) | `docker compose up` from a clean state reaches all-healthy | smoke script 3.2 |
| 3.1a | **Known risk: sandbox files when the worker runs in a container.** The worker passes host paths to `docker run -v`; inside a container those paths do not exist on the host. Fix by sharing a host directory mounted at the same path in the worker, or by sending files over stdin (as the warm pool does) | AI snapshot jobs and Run jobs pass inside compose | smoke script runs one Run job and one sandbox snapshot job |
| 3.2 | **Deploy smoke test** `scripts/deploy-smoke.*`: compose up, wait healthy, check `/health` of every service through Nginx, open a WebSocket through Nginx to both sync nodes, run one sandbox job, tear down | exit 0 from a clean checkout | log saved under `benchmarks/results/logs/` |
| 3.3 | **CI green on GitHub:** check the first Actions run of `main` (`7c8c528`); fix Linux-only failures; add jobs for web production build, UI suite, and compose build | all jobs green on `main` | Actions run links in `docs/PROGRESS.md` |
| 3.4 | **Failure table** in the README: scenario → expected behaviour → evidence. Rows: sync node killed, Redis restart, Postgres down, worker crash mid-job, AI provider down/timeout, malformed LLM output, stale patch, sandbox attacks, queue full, rate limit, browser offline. Each row links to its test or results file; a row without a test is marked "untested" | every row has evidence or says untested | README |
| 3.5 | **Demo script** `docs/DEMO.md` for the owner to record: the 5 scenarios from plan §7.2 (kill a sync node mid-edit; fork bomb and output flood contained; crash a worker mid-job and see the retry; edit during AI work and see the stale patch caught; first AI attempt fails, retry passes), each with setup commands, exact clicks, what the viewer should see, and reset steps | the owner can follow it without asking | dry-run each scenario once and note the result |
| 3.6 | **README a stranger can follow:** prerequisites (Docker Desktop, Node 20+, Python 3.12), `.env` setup (Clerk keys, optional LLM key), one-command start, how to run tests and benchmarks, troubleshooting (Windows memory / Docker Desktop note) | a fresh clone in a new folder starts from the README alone | log of that fresh-clone run |

## Order and rough effort

1. Part 1 (backend support): about 2–3 hours
2. Part 2 (frontend + UI tests): about 1–1.5 days
3. 3.3 CI green: as soon as the first Actions result is visible, in parallel
4. 3.1, 3.1a, 3.2 (compose deploy + smoke): about half a day; 3.1a is the riskiest item
5. 3.4, 3.5, 3.6 (failure table, demo script, README fresh-clone check): about half a day

## Still open, not in this plan unless the owner asks

- **B5 real-provider eval:** owner runs it with their key, then `python benchmarks/report.py --update-readme`.
- **Week 9–10 gaps:** "verified" should require a reproducing test that fails on the original code first (today the loop only checks that tests pass after the fix). Progress streaming is covered by step 1.2.
- **Benchmark findings, measured but not fixed:** queue cap not atomic under concurrent submissions; the 5 s sandbox timeout includes container start; keyword search returns nothing for sentence-length queries; 100-client room p95 3.9 s.
- **Plan gaps:** 25 eval cases instead of 50; RAG-vs-none ablation needs multi-file rooms; separate worker VM is documented, not built.
- **Housekeeping:** five unused `TODO` stub files; duplicate plan PDF in the repo root.
