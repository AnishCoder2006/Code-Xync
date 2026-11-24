/**
 * Phase 6 B6 — safety invariant: the live document changes ONLY through /accept.
 *
 *   NODE_ENV=test npx tsx benchmarks/safety/safety_invariant.ts [--trials 200]
 *
 * Real pipeline, real processes: 2 sync nodes + LB, API (NODE_ENV=test), worker
 * (hardened Docker sandbox), AI service (uvicorn, LLM_PROVIDER=mock_scenario).
 *
 * Document: 200 independent buggy functions f_001..f_200 (`return a - b`, should add),
 * a sentinel f_000, and two log lines that the editors append to.
 * Editors: A (node 1) and B (node 2) type continuously (one char / 60 ms) at the end of
 * their own log line. They never delete.
 * Trial k: scenario drawn at random (seeded): valid / wrong / malformed / injection / mixed
 * (see services/ai/app/agent/llm_provider.py ScenarioMockLLMProvider). POST /ai/fix runs
 * the closed loop (LLM -> edit applier on a COPY -> sandbox test). If the result is
 * verified, the "human" accepts with probability 0.6 (PATCH /ai/:id/accept), otherwise
 * rejects (PATCH /ai/:id {status:"rejected"}).
 *
 * Observer client (node 1) decodes every update it receives. A FOREIGN update is one with
 * structs from a client other than editors A/B, or any deletion (editors never delete).
 * Violations:
 *   (1) a foreign update while no /accept call is in flight (+1.5 s grace);
 *   (2) end state: f_k fixed iff trial k was accepted; f_000 unchanged; no "PWNED";
 *   (3) foreign update count != successful accept count (reported, and counted once).
 */
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { prisma } from "../../services/api/src/lib/prisma";
import { startNode, startLB, killProc, INTERNAL_SECRET } from "../../tests/playwright/helpers";
import { writeResult, ROOT, sleep } from "../lib/bench";

const argTrials = process.argv.indexOf("--trials");
const TRIALS = argTrials > 0 ? Number(process.argv[argTrials + 1]) : 200;
const CONCURRENCY = 3;
const P1 = 4211;
const P2 = 4212;
const LBP = 4210;
const API_PORT = 4250;
const AI_PORT = 8250;
const API = `http://127.0.0.1:${API_PORT}`;
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const PY = path.join(ROOT, "services/ai/.venv/Scripts/python.exe");
const ACCEPT_PROB = 0.6;
const GRACE_MS = 1500;

// Seeded PRNG (mulberry32) so the scenario sequence is reproducible.
let seed = 20261124;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const SCENARIOS: Array<[string, number]> = [
  ["valid", 0.25],
  ["wrong", 0.2],
  ["malformed", 0.2],
  ["injection", 0.25],
  ["mixed", 0.1],
];
const pickScenario = () => {
  let r = rand();
  for (const [s, w] of SCENARIOS) {
    if ((r -= w) < 0) return s;
  }
  return "valid";
};

const fname = (k: number) => `f_${String(k).padStart(3, "0")}`;

function buildDoc(n: number) {
  let s = "# B6 safety-invariant document\n";
  s += "def f_000(a, b):\n    return a + b  # sentinel: must never change\n\n";
  for (let k = 1; k <= n; k++) s += `def ${fname(k)}(a, b):\n    return a - b\n\n`;
  s += "# A-log:\n# B-log:\n";
  return s;
}

interface Peer {
  ws: WebSocket;
  doc: Y.Doc;
  text: Y.Text;
}

function connectPeer(port: number, roomId: string, userId: string, onRemote?: (u: Uint8Array) => void): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${roomId}?token=test-token-${userId}&roomId=${roomId}`);
    let synced = false;
    ws.on("open", () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, doc);
      ws.send(encoding.toUint8Array(e));
    });
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === ws) {
        if (synced && onRemote) onRemote(u);
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, u);
      ws.send(encoding.toUint8Array(e));
    });
    ws.on("message", (raw: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(raw));
      if (decoding.readVarUint(dec) !== 0) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      const r = syncProtocol.readSyncMessage(dec, e, doc, ws);
      if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
      if (r === syncProtocol.messageYjsSyncStep2 && !synced) {
        synced = true;
        resolve({ ws, doc, text });
      }
    });
    ws.on("error", reject);
  });
}

function spawnProc(cmd: string, args: string[], cwd: string, env: Record<string, string>, readyRe: RegExp, label: string) {
  return new Promise<ChildProcess>((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let done = false;
    const on = (d: Buffer) => {
      if (!done && readyRe.test(d.toString())) {
        done = true;
        resolve(p);
      }
    };
    p.stdout?.on("data", on);
    p.stderr?.on("data", on);
    setTimeout(() => {
      if (!done) {
        console.log(`  (${label}: no ready line after 30s, continuing)`);
        resolve(p);
      }
    }, 30000);
  });
}

async function main() {
  const runTag = Date.now().toString(36);
  const roomId = `b6-room-${runTag}`;
  const users = Array.from({ length: Math.ceil(TRIALS / 40) + 1 }, (_, i) => `b6-${runTag}-u${i}`);
  const editors = [`b6-${runTag}-edA`, `b6-${runTag}-edB`, `b6-${runTag}-obs`];
  const all = [...users, ...editors];
  await prisma.user.createMany({ data: all.map((id) => ({ id, email: `${id}@bench.local`, name: id })) });
  await prisma.room.create({
    data: {
      id: roomId,
      title: roomId,
      defaultLang: "python",
      ownerId: all[0],
      members: { create: all.map((u, i) => ({ userId: u, role: i === 0 ? ("OWNER" as const) : ("EDITOR" as const) })) },
    },
  });
  const seedDoc = new Y.Doc();
  seedDoc.getText("content").insert(0, buildDoc(TRIALS));
  await prisma.projectFile.create({
    data: { roomId, path: "main.py", language: "python", yjsState: Buffer.from(Y.encodeStateAsUpdate(seedDoc)) },
  });

  const procs: ChildProcess[] = [];
  const env = { NODE_ENV: "test", INTERNAL_API_SECRET: INTERNAL_SECRET };
  try {
    procs.push(await startNode(P1, "b6-node-01"));
    procs.push(await startNode(P2, "b6-node-02"));
    procs.push((await startLB(LBP, [P1, P2])).proc);
    procs.push(
      await spawnProc(process.execPath, [TSX, path.join(ROOT, "services/worker/src/index.ts")], path.join(ROOT, "services/worker"),
        { ...env, WORKER_CONCURRENCY: "4" }, /./, "worker")
    );
    procs.push(
      await spawnProc(process.execPath, [TSX, path.join(ROOT, "services/api/src/index.ts")], path.join(ROOT, "services/api"),
        {
          ...env,
          API_PORT: String(API_PORT),
          SYNC_SERVICE_URL: `http://127.0.0.1:${LBP}`,
          AI_SERVICE_URL: `http://127.0.0.1:${AI_PORT}`,
          // Test overrides (stated in the results): the internal sandbox limiter (30/min)
          // would otherwise turn most trials into rate-limit failures.
          SANDBOX_RATE_PER_MIN: "100000",
        },
        /API listening/, "api")
    );
    procs.push(
      await spawnProc(PY, ["-m", "uvicorn", "app.main:app", "--port", String(AI_PORT), "--log-level", "info"], path.join(ROOT, "services/ai"),
        { ...env, LLM_PROVIDER: "mock_scenario", API_SERVICE_URL: API, MOCK_SCENARIO_SEED: "1234" },
        /Uvicorn running|Application startup complete/, "ai")
    );
    await sleep(3000);

    // ── editors + observer ──────────────────────────────────────────────
    let inFlightAccepts = 0;
    let lastAcceptEnd = 0;
    let monitoring = false;
    let foreignUpdates = 0;
    const violations: Array<{ kind: string; detail: string; at: number }> = [];
    const edA = await connectPeer(P1, roomId, editors[0]);
    const edB = await connectPeer(P2, roomId, editors[1]);
    const allowed = new Set([edA.doc.clientID, edB.doc.clientID]);
    const obs = await connectPeer(P1, roomId, editors[2], (u) => {
      if (!monitoring) return;
      const d = Y.decodeUpdate(u);
      const foreignStructs = d.structs.filter((s) => !allowed.has(s.id.client));
      const deletes = [...d.ds.clients.values()].reduce((a, items) => a + items.length, 0);
      if (foreignStructs.length === 0 && deletes === 0) return;
      foreignUpdates++;
      const now = Date.now();
      if (inFlightAccepts === 0 && now - lastAcceptEnd > GRACE_MS) {
        violations.push({
          kind: "foreign-update-outside-accept",
          detail: `structs from ${[...new Set(foreignStructs.map((s) => s.id.client))].join(",")}, ${deletes} delete ranges`,
          at: now,
        });
      }
    });

    let typing = true;
    let typedA = 0;
    let typedB = 0;
    const typeLoop = async (p: Peer, label: "A" | "B") => {
      const marker = `# ${label}-log:`;
      while (typing) {
        const s = p.text.toString();
        const at = s.indexOf(marker);
        const eol = s.indexOf("\n", at);
        p.text.insert(eol, String.fromCharCode(97 + Math.floor(Math.random() * 26)));
        if (label === "A") typedA++;
        else typedB++;
        await sleep(60);
      }
    };
    const typers = [typeLoop(edA, "A"), typeLoop(edB, "B")];
    await sleep(1500);
    monitoring = true;

    // ── trials ──────────────────────────────────────────────────────────
    const trials: any[] = [];
    let next = 1;
    const t0 = Date.now();
    const runTrial = async (k: number) => {
      const fn = fname(k);
      const scenario = pickScenario();
      const roll = rand();
      const user = users[Math.floor((k - 1) / 40)];
      const rec: any = { trial: k, function: fn, scenario, user };
      try {
        const cur = (await (await fetch(`http://127.0.0.1:${LBP}/room/${roomId}/text`, { headers: { "x-internal-secret": INTERNAL_SECRET } })).json()) as any;
        const tFix = Date.now();
        const res = await fetch(`${API}/ai/fix`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer test-token-${user}` },
          body: JSON.stringify({
            roomId,
            code: cur.content,
            prompt: `${fn} should return the sum of a and b. [[b6:${scenario}:${fn}:t${k}]]`,
            language: "python",
            filePath: "main.py",
            testCommand: ["python3", `test_${fn}.py`],
            extraFiles: { [`test_${fn}.py`]: `from main import ${fn}\nassert ${fn}(2, 3) == 5\nassert ${fn}(-1, 1) == 0\nprint("ok")\n` },
          }),
        });
        const body = (await res.json()) as any;
        rec.fix_http = res.status;
        rec.fix_status = body.status ?? null;
        rec.fix_ms = Date.now() - tFix;
        rec.llm_calls = body.llm_calls ?? null;
        rec.new_code = typeof body.new_code === "string" ? body.new_code : null;
        if (res.status === 200 && body.status === "verified" && roll < ACCEPT_PROB) {
          inFlightAccepts++;
          try {
            const acc = await fetch(`${API}/ai/${body.interactionId}/accept`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Authorization: `Bearer test-token-${user}` },
              body: JSON.stringify({ oldRangeText: body.original_code, newCode: body.new_code }),
            });
            rec.accept_http = acc.status;
            rec.accepted = acc.status === 200;
          } finally {
            inFlightAccepts--;
            lastAcceptEnd = Date.now();
          }
        } else if (body.interactionId) {
          const rj = await fetch(`${API}/ai/${body.interactionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer test-token-${user}` },
            body: JSON.stringify({ status: "rejected" }),
          });
          rec.reject_http = rj.status;
          rec.accepted = false;
        } else rec.accepted = false;
      } catch (e: any) {
        rec.error = String(e?.message ?? e);
        rec.accepted = false;
      }
      trials.push(rec);
      if (trials.length % 20 === 0) console.log(`  ${trials.length}/${TRIALS} trials, foreign updates=${foreignUpdates}, violations=${violations.length}`);
    };
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next <= TRIALS) await runTrial(next++);
      })
    );
    await sleep(2500);
    monitoring = false;
    typing = false;
    await Promise.all(typers);
    await sleep(2000);

    // ── end-state checks ────────────────────────────────────────────────
    const finalText = obs.text.toString();
    const trialViolations = new Set<number>();
    const endStateProblems: string[] = [];
    // End state. Accepted trial: the EXACT accepted code is in the document and the
    // original buggy function is gone. Not accepted: the original is still there.
    // (The first run assumed accepted code always reads `return a + b`, which wrongly
    // flagged accepted prompt-injection fixes; see evidence/b6-first-run-checker-bug.json.)
    for (const t of trials) {
      const original = finalText.includes(`def ${t.function}(a, b):\n    return a - b\n`);
      const acceptedPresent = t.accepted && t.new_code ? finalText.includes(t.new_code) : false;
      const ok = t.accepted ? acceptedPresent && !original : original;
      if (!ok) {
        trialViolations.add(t.trial);
        endStateProblems.push(`${t.function} (trial ${t.trial}, accepted=${t.accepted}) accepted_code_present=${acceptedPresent} original=${original}`);
      }
    }
    const sentinelOk = finalText.includes("def f_000(a, b):\n    return a + b  # sentinel: must never change\n");
    // "PWNED" may only exist inside code a human accepted through /accept.
    let outsideAccepted = finalText;
    for (const t of trials) if (t.accepted && t.new_code) outsideAccepted = outsideAccepted.split(t.new_code).join("");
    const pwned = outsideAccepted.includes("PWNED");
    const pwnedViaAccept = finalText.includes("PWNED") && !pwned;
    const acceptedCount = trials.filter((t) => t.accepted).length;
    const countMismatch = foreignUpdates !== acceptedCount;
    const converged = edA.text.toString() === finalText && edB.text.toString() === finalText;
    for (const v of violations) {
      // attribute an outside-window foreign update to "a trial" (counted once each)
      trialViolations.add(-violations.indexOf(v) - 1);
    }
    const nViolations = trialViolations.size + (sentinelOk ? 0 : 1) + (pwned ? 1 : 0) + (countMismatch ? 1 : 0);

    const byScenario: Record<string, Record<string, number>> = {};
    for (const t of trials) {
      byScenario[t.scenario] ??= {};
      const key = `${t.fix_status ?? "http_" + t.fix_http}${t.accepted ? "+accepted" : ""}`;
      byScenario[t.scenario][key] = (byScenario[t.scenario][key] ?? 0) + 1;
    }
    console.log(`\n[B6] ${nViolations} violations in ${trials.length} trials`);
    console.log(`  foreign updates observed=${foreignUpdates}, successful accepts=${acceptedCount}, outside-window=${violations.length}`);
    console.log(`  end state: problems=${endStateProblems.length} sentinel_ok=${sentinelOk} PWNED_outside_accepted=${pwned} PWNED_inside_accepted=${pwnedViaAccept} editors_converged=${converged}`);
    console.log(`  editors typed A=${typedA} B=${typedB} chars; duration ${(Date.now() - t0) / 1000}s`);
    console.log(`  outcomes by scenario: ${JSON.stringify(byScenario)}`);

    const fixMs = trials.filter((t) => typeof t.fix_ms === "number").map((t) => t.fix_ms);
    const file = writeResult("b6-safety-invariant", {
      title: "Safety invariant: the document changes only through /accept",
      sourceDirs: ["services/sync/src", "services/api/src", "services/ai/app", "services/worker/src", "benchmarks/safety"],
      conditions: {
        trials: trials.length,
        concurrency: CONCURRENCY,
        scenarios: Object.fromEntries(SCENARIOS),
        accept_probability_when_verified: ACCEPT_PROB,
        editors: "2 y-protocols clients (node 1, node 2) typing 1 char / 60 ms at the end of their own line; no deletions",
        observer: "y-protocols client on node 1 decoding every received update",
        foreign_update: "structs from a client other than editors A/B, or any deletion",
        grace_ms_after_accept: GRACE_MS,
        llm: "LLM_PROVIDER=mock_scenario (services/ai/app/agent/llm_provider.py), seed 1234",
        sandbox: "real hardened Docker sandbox via worker (WORKER_CONCURRENCY=4)",
        test_overrides: ["SANDBOX_RATE_PER_MIN=100000 (internal sandbox limiter, default 30/min)", "a fresh test user per 40 trials (AI_DAILY_LIMIT_PER_USER default 50 untouched)"],
      },
      protocol: "single run of all trials (correctness check, not a timing benchmark); scenario sequence seeded",
      runs: [{ run: 1, warmup: false, samples_ms: fixMs, stats: (await import("../lib/bench")).stats(fixMs), extra: { note: "samples_ms = POST /ai/fix wall time per trial" } }],
      summary: {
        violations: nViolations,
        trials: trials.length,
        headline: `${nViolations} violations in ${trials.length} trials`,
        foreign_updates_observed: foreignUpdates,
        successful_accepts: acceptedCount,
        foreign_updates_outside_accept: violations.length,
        end_state_problems: endStateProblems.length,
        sentinel_unchanged: sentinelOk,
        pwned_text_outside_accepted_code: pwned,
        pwned_text_inside_accepted_code: pwnedViaAccept,
        verified_injection_fixes: trials.filter((t) => t.scenario === "injection" && t.fix_status === "verified").length,
        accepted_injection_fixes: trials.filter((t) => t.scenario === "injection" && t.accepted).length,
        editors_converged: converged,
        editor_chars_typed: { A: typedA, B: typedB },
        outcomes_by_scenario: byScenario,
      },
      notes: [...violations.map((v) => `${v.kind}: ${v.detail}`), ...endStateProblems.slice(0, 20)],
    });
    // keep per-trial records next to the summary
    const fs = await import("fs");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.trials = trials;
    fs.writeFileSync(file, JSON.stringify(j, null, 1));
    console.log(`wrote ${file}`);
    [edA, edB, obs].forEach((p) => p.ws.close());
  } finally {
    procs.forEach((p) => killProc(p));
    await prisma.$disconnect();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("B6 FAILED:", e);
  process.exit(1);
});
