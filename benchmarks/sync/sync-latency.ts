/**
 * Phase 6 B1 — edit-to-peer-receive latency on two sync nodes behind the balancer.
 *
 *   NODE_ENV=test npx tsx benchmarks/sync/sync-latency.ts [--quick]
 *
 * Why not k6: k6 runs JavaScript in its own runtime (goja), which cannot load the
 * `yjs` / `y-protocols` npm libraries, so it cannot speak the Yjs sync protocol. This
 * harness uses real y-protocols clients on Node (`ws` + `yjs`).
 *
 * Topology: sync node 1 (:4111) + node 2 (:4112), started fresh by this script, behind
 * the round-robin LB (:4110). Every client connects THROUGH the LB; which node it landed
 * on is read from the LB's routing log, so each sample is labelled same-node/cross-node.
 * Clients are spread over LOADERS child processes (benchmarks/sync/loader.ts).
 *
 * Scenarios: 1 room x 10, 1 room x 50, 1 room x 100 clients, and 50 rooms x 4 clients.
 * Each client appends a marker every INTERVAL_MS (1 edit/s by default) for EDITS edits,
 * with a random phase. One warm-up run, then 3 measured runs; fresh rooms per run.
 * The load generator shares the machine with both nodes, Redis and Postgres.
 */
import { fork, ChildProcess } from "child_process";
import path from "path";
import { prisma } from "../../services/api/src/lib/prisma";
import { startNode, startLB, killProc, wait } from "../../tests/playwright/helpers";
import { stats, writeResult, RunRecord, sleep } from "../lib/bench";

const QUICK = process.argv.includes("--quick");
const P1 = 4111;
const P2 = 4112;
const LBP = 4110;
const LOADERS = 4;
const EDITS = QUICK ? 5 : 20;
const WARMUP_EDITS = 5;
const INTERVAL_MS = 1000;
const RUNS = QUICK ? 1 : 3;

const SCENARIOS = [
  { name: "1room-10clients", rooms: 1, perRoom: 10 },
  { name: "1room-50clients", rooms: 1, perRoom: 50 },
  { name: "1room-100clients", rooms: 1, perRoom: 100 },
  { name: "50rooms-4clients", rooms: 50, perRoom: 4 },
];

const MAX_USERS = Math.max(...SCENARIOS.map((s) => s.rooms * s.perRoom));
const users = Array.from({ length: MAX_USERS }, (_, i) => `b1-user-${i}`);

async function seedUsers() {
  for (let i = 0; i < users.length; i += 50) {
    await prisma.user.createMany({
      data: users.slice(i, i + 50).map((id) => ({ id, email: `${id}@bench.local`, name: id })),
      skipDuplicates: true,
    });
  }
}

async function seedRooms(tag: string, rooms: number, perRoom: number) {
  const out: Array<{ idx: number; userId: string; roomId: string }> = [];
  for (let r = 0; r < rooms; r++) {
    const roomId = `b1-${tag}-r${r}`;
    const members = users.slice(r * perRoom, (r + 1) * perRoom);
    await prisma.room.create({
      data: {
        id: roomId,
        title: roomId,
        ownerId: members[0],
        members: { create: members.map((u, i) => ({ userId: u, role: i === 0 ? ("OWNER" as const) : ("EDITOR" as const) })) },
      },
    });
    members.forEach((u) => out.push({ idx: out.length, userId: u, roomId }));
  }
  return out;
}

function startLoaders(): ChildProcess[] {
  return Array.from({ length: LOADERS }, () =>
    fork(path.join(__dirname, "loader.ts"), [], { execArgv: ["--import", "tsx"], env: process.env })
  );
}

const ask = (p: ChildProcess, msg: any, expect: string) =>
  new Promise<any>((resolve) => {
    const h = (m: any) => {
      if (m.type === expect) {
        p.off("message", h);
        resolve(m);
      }
    };
    p.on("message", h);
    p.send(msg);
  });

async function oneRun(scn: (typeof SCENARIOS)[number], run: number, warmup: boolean, lbLog: string[]): Promise<RunRecord> {
  const tag = `${scn.name}-${warmup ? "w" : run}-${Date.now().toString(36)}`;
  const clients = await seedRooms(tag, scn.rooms, scn.perRoom);
  const loaders = startLoaders();
  try {
    const logStart = lbLog.length;
    const shares = loaders.map((_, i) => clients.filter((_, j) => j % LOADERS === i));
    await Promise.all(loaders.map((l, i) => ask(l, { type: "connect", url: `ws://127.0.0.1:${LBP}`, clients: shares[i] }, "connected")));

    // Placement from the LB routing log: "[lb] ws N -> 127.0.0.1:4111 (...) /room?token=test-token-<uid>&..."
    const nodeOf = new Map<string, number>();
    for (const line of lbLog.slice(logStart)) {
      const m = /-> 127\.0\.0\.1:(\d+) .*test-token-([^&\s]+)/.exec(line);
      if (m) nodeOf.set(m[2], Number(m[1]));
    }
    const placement = { node1: 0, node2: 0, unknown: 0 };
    clients.forEach((c) => {
      const n = nodeOf.get(c.userId);
      if (n === P1) placement.node1++;
      else if (n === P2) placement.node2++;
      else placement.unknown++;
    });

    const edits = warmup ? WARMUP_EDITS : EDITS;
    const startAt = Date.now() + 1000;
    await Promise.all(loaders.map((l) => ask(l, { type: "go", startAt, edits, intervalMs: INTERVAL_MS }, "sent")));
    await sleep(3000); // drain
    const parts = await Promise.all(loaders.map((l) => ask(l, { type: "collect" }, "done")));
    loaders.forEach((l) => l.send({ type: "close" }));

    const all: Array<[number, number, number]> = parts.flatMap((p) => p.samples);
    const sent = parts.reduce((a, p) => a + p.sent, 0);
    const expected = scn.rooms * scn.perRoom * edits * (scn.perRoom - 1);
    const lat = all.map((s) => Math.round(s[0] * 100) / 100);
    const sameNode: number[] = [];
    const crossNode: number[] = [];
    for (const [l, sIdx, rIdx] of all) {
      const a = nodeOf.get(clients[sIdx].userId);
      const b = nodeOf.get(clients[rIdx].userId);
      (a !== undefined && a === b ? sameNode : crossNode).push(l);
    }
    const st = stats(lat);
    console.log(
      `  ${scn.name} ${warmup ? "warm-up" : "run " + run}: sent=${sent} delivered=${all.length}/${expected} ` +
        `p50=${st.p50} p95=${st.p95} p99=${st.p99} ms (placement n1=${placement.node1} n2=${placement.node2} ?=${placement.unknown})`
    );
    return {
      run,
      warmup,
      samples_ms: lat,
      stats: st,
      extra: {
        edits_sent: sent,
        deliveries_expected: expected,
        deliveries_received: all.length,
        deliveries_missing: expected - all.length,
        placement,
        same_node: stats(sameNode),
        cross_node: stats(crossNode),
      },
    };
  } finally {
    loaders.forEach((l) => killProc(l));
  }
}

async function main() {
  await seedUsers();
  const n1 = await startNode(P1, "b1-node-01");
  const n2 = await startNode(P2, "b1-node-02");
  const lb = await startLB(LBP, [P1, P2]);
  await wait(1500);
  const files: string[] = [];
  try {
    for (const scn of SCENARIOS) {
      console.log(`\n[B1] ${scn.name}: ${scn.rooms} room(s) x ${scn.perRoom} clients, ${EDITS} edits/client @ ${INTERVAL_MS}ms`);
      const runs: RunRecord[] = [await oneRun(scn, 0, true, lb.log)];
      for (let r = 1; r <= RUNS; r++) runs.push(await oneRun(scn, r, false, lb.log));
      const file = writeResult(`b1-sync-latency-${scn.name}`, {
        title: `Sync edit-to-peer latency: ${scn.rooms} room(s) x ${scn.perRoom} clients`,
        sourceDirs: ["services/sync/src", "benchmarks/sync", "benchmarks/lib"],
        conditions: {
          rooms: scn.rooms,
          clients_per_room: scn.perRoom,
          total_clients: scn.rooms * scn.perRoom,
          edit_rate_per_client: `1 edit / ${INTERVAL_MS} ms (random phase)`,
          edits_per_client_measured_run: EDITS,
          edits_per_client_warmup: WARMUP_EDITS,
          edit_payload: "append one ~25-byte marker to Y.Text 'content'",
          topology: `2 sync nodes (:${P1}, :${P2}) behind the Node round-robin LB (:${LBP}); Redis Pub/Sub relay (Redis 7 in Docker Desktop, :6380)`,
          client: `y-protocols over ws (Node ${process.version}), ${LOADERS} loader processes`,
          measured: "receiver wall-clock (performance.timeOrigin+now) minus sender timestamp embedded in the edit; every peer of every edit",
          load_generator: "same machine as both nodes, the LB, Redis and Postgres",
          k6: "not used: k6's goja runtime cannot run the yjs/y-protocols libraries",
        },
        protocol: `1 warm-up run (${WARMUP_EDITS} edits/client) + ${RUNS} measured runs; fresh rooms each run; 3 s drain before collecting`,
        runs,
        notes: [
          "Samples include same-node and cross-node peers; per-run breakdown is in runs[].extra.same_node / cross_node.",
          "deliveries_missing counts edit deliveries not observed within the 3 s drain.",
        ],
      });
      files.push(file);
    }
  } finally {
    killProc(n1);
    killProc(n2);
    killProc(lb.proc);
    await prisma.$disconnect();
  }
  console.log("\nwrote:\n  " + files.join("\n  "));
  process.exit(0);
}

main().catch((e) => {
  console.error("B1 FAILED:", e);
  process.exit(1);
});
