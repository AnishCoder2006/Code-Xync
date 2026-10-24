# CodeSync

Real-time collaborative code editor with sandboxed execution and a verified AI fix loop.
See `docs/codesync-implementation-plan-v4.pdf` for the full design and 12-week roadmap.

## Services
- `apps/web` — Next.js client (Monaco, xterm.js, Yjs)
- `services/api` — REST API, auth, RBAC, job enqueue (Node.js/TS, Express)
- `services/sync` — WebSocket sync nodes (Yjs + Redis Pub/Sub)
- `services/worker` — Sandboxed execution workers (Node.js/TS, BullMQ, Docker)
- `services/ai` — AI/RAG microservice (FastAPI, LangGraph, Qdrant, tree-sitter)
- `infra` — Docker Compose, Nginx, deployment config
- `benchmarks` — attack payloads, load tests, AI evaluation set
- `tests/playwright` — multi-client convergence / reconnect / node-kill tests
- `prisma` — database schema (Postgres via Supabase)

## Getting started
1. `cp .env.example .env` and fill in values (see comments in the file)
2. `docker compose -f infra/docker/docker-compose.yml up -d` (Postgres, Redis, Qdrant)
3. `cd prisma && npx prisma migrate dev`
4. Start each service — see its own README
5. Open `apps/web` at http://localhost:3000

## Status
Week 1 — foundation. Start with `docs/PHASE1.md` for a step-by-step checklist
(infra, DB, auth, rooms/RBAC, logging). See `docs/codesync-implementation-plan-v4.pdf`
for the full 12-week roadmap.
