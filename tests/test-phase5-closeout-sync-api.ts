process.env.NODE_ENV = "test";
process.env.AI_DAILY_LIMIT_PER_USER = "10";
process.env.INTERNAL_API_SECRET = "codesync-internal-ai-secret";

import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import express from "express";
import http from "http";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { prisma } from "../services/api/src/lib/prisma";
import aiRouter from "../services/api/src/routes/ai";
import executionRouter from "../services/api/src/routes/execution";

function killProcessTree(proc: ChildProcess | null) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {}
}

import path from "path";

const SYNC_DIST = path.resolve(__dirname, "../services/sync/dist/index.js");
const WORKER_DIST = path.resolve(__dirname, "../services/worker/dist/index.js");
const PYTHON_EXE = path.resolve(__dirname, "../services/ai/.venv/Scripts/python.exe");
const AI_DIR = path.resolve(__dirname, "../services/ai");

const SYNC_PORT = 4095;
const API_PORT = 4096;
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");

async function main() {
  console.log("=========================================================================");
  console.log("       CodeSync Phase 5 Closeout: Verification & Invariant Suite         ");
  console.log("=========================================================================\n");

  let syncProcess: ChildProcess | null = null;
  let workerProcess: ChildProcess | null = null;
  let apiServer: http.Server | null = null;

  try {
    // Clean old leftover jobs and rate limits in Redis
    console.log("[Setup] Cleaning Redis BullMQ execution queue and rate limit keys...");
    const oldKeys = await redis.keys("bull:code_execution:*");
    if (oldKeys.length > 0) {
      await redis.del(...oldKeys);
    }
    const rlKeys = await redis.keys("ratelimit:*");
    if (rlKeys.length > 0) {
      await redis.del(...rlKeys);
    }
    console.log(`   -> Cleaned ${oldKeys.length} stale queue keys and ${rlKeys.length} rate limit keys.\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 0: Start Sync Service on SYNC_PORT
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[Setup] Starting Sync Service on port ${SYNC_PORT}...`);
    await new Promise<void>((resolve, reject) => {
      syncProcess = spawn("node", [SYNC_DIST], {
        env: {
          ...process.env,
          SYNC_PORT: String(SYNC_PORT),
          PORT: String(SYNC_PORT),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let started = false;
      syncProcess.stdout?.on("data", (d) => {
        const out = d.toString();
        if (out.includes(`Sync service running on :${SYNC_PORT}`) && !started) {
          started = true;
          resolve();
        }
      });
      syncProcess.stderr?.on("data", (d) => {
        console.error(`[sync-err] ${d.toString().trim()}`);
      });
      syncProcess.on("exit", (code) => {
        console.log(`[sync-exit] process exited with code ${code}`);
      });
      syncProcess.on("error", reject);
      setTimeout(() => {
        if (!started) {
          started = true;
          resolve();
        }
      }, 5000);
    });
    console.log("   -> Sync service running.\n");

    // ─────────────────────────────────────────────────────────────────────────
    // Step 0b: Start Worker Service for real sandbox jobs
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[Setup] Starting Worker Service for sandbox jobs...");
    workerProcess = spawn("node", [WORKER_DIST], {
      env: {
        ...process.env,
        REDIS_URL: process.env.REDIS_URL || "redis://localhost:6380",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    workerProcess.stderr?.on("data", (d) => {
      console.error(`[worker-err] ${d.toString().trim()}`);
    });
    await new Promise((r) => setTimeout(r, 1500));
    console.log("   -> Worker service running.\n");

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Start Express API server on API_PORT
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[Setup] Starting API Service on port ${API_PORT}...`);
    let activeUser: any = null;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (activeUser) {
        req.user = activeUser;
      }
      next();
    });
    process.env.SYNC_SERVICE_URL = `http://localhost:${SYNC_PORT}`;
    process.env.INTERNAL_API_SECRET = "codesync-internal-ai-secret";

    app.use("/ai", aiRouter);
    app.use("/execution", executionRouter);

    await new Promise<void>((resolve) => {
      apiServer = app.listen(API_PORT, () => resolve());
    });
    console.log("   -> API service running.\n");

    // Seed test users & room
    const ownerId = "owner-" + uuidv4().slice(0, 8);
    const editorId = "editor-" + uuidv4().slice(0, 8);
    const viewerId = "viewer-" + uuidv4().slice(0, 8);
    const nonMemberId = "nonmember-" + uuidv4().slice(0, 8);
    const roomId = "closeout-room-" + uuidv4().slice(0, 8);

    await prisma.user.createMany({
      data: [
        { id: ownerId, email: `${ownerId}@test.com`, name: "Owner" },
        { id: editorId, email: `${editorId}@test.com`, name: "Editor" },
        { id: viewerId, email: `${viewerId}@test.com`, name: "Viewer" },
        { id: nonMemberId, email: `${nonMemberId}@test.com`, name: "Non Member" },
      ],
    });

    await prisma.room.create({
      data: {
        id: roomId,
        title: "Phase 5 Closeout Room",
        ownerId: ownerId,
        defaultLang: "python",
        members: {
          create: [
            { userId: ownerId, role: "OWNER" },
            { userId: editorId, role: "EDITOR" },
            { userId: viewerId, role: "VIEWER" },
          ],
        },
      },
    });

    const ownerUser = await prisma.user.findUnique({ where: { id: ownerId } });
    const editorUser = await prisma.user.findUnique({ where: { id: editorId } });
    const viewerUser = await prisma.user.findUnique({ where: { id: viewerId } });
    const nonMemberUser = await prisma.user.findUnique({ where: { id: nonMemberId } });

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 1 & LEGACY PATCH RESTRICTION:
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[Item 1] Testing Legacy PATCH /ai/:id restriction & Reject...");

    activeUser = ownerUser;
    const testInteraction = await prisma.aIInteraction.create({
      data: {
        roomId,
        userId: ownerId,
        prompt: "test fix to reject",
        baseVersion: "dummy",
        status: "pending",
      },
    });

    // 1.1 Legacy PATCH /ai/:id with status 'verified' must be rejected with 400
    let res = await fetch(`http://localhost:${API_PORT}/ai/${testInteraction.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "verified" }),
    });
    console.log(`   1.1 Legacy PATCH /ai/:id with status='verified': status ${res.status} (expected 400)`);
    if (res.status !== 400) throw new Error(`Expected 400 for legacy accept, got ${res.status}`);

    // 1.2 Legacy PATCH /ai/:id with status 'rejected' succeeds
    res = await fetch(`http://localhost:${API_PORT}/ai/${testInteraction.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    console.log(`   1.2 Legacy PATCH /ai/:id with status='rejected': status ${res.status} (expected 200)`);
    if (res.status !== 200) throw new Error(`Expected 200 for reject, got ${res.status}`);
    const rejectedInDb = await prisma.aIInteraction.findUnique({ where: { id: testInteraction.id } });
    if (rejectedInDb?.status !== "rejected") throw new Error("Expected interaction status to be rejected in DB");
    console.log("   -> PASS: Item 1 legacy PATCH restricted to 'rejected' only.\n");

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 2: Auth and Rate Limiting on POST /execution/sandbox
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[Item 2] Testing POST /execution/sandbox Auth and Rate Limit...");

    // 2.1 Unauthenticated request returns 401
    const unauthRes = await fetch(`http://localhost:${API_PORT}/execution/sandbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: "test",
        files: { "main.py": "print('hello')" },
        command: ["python3", "main.py"],
        language: "python",
      }),
    });
    console.log(`   2.1 Unauthenticated POST /execution/sandbox status: ${unauthRes.status} (expected 401)`);
    if (unauthRes.status !== 401) throw new Error(`Expected 401 for unauthenticated request, got ${unauthRes.status}`);

    // 2.2 Invalid secret header returns 401
    const badSecretRes = await fetch(`http://localhost:${API_PORT}/execution/sandbox`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": "invalid-secret-key",
      },
      body: JSON.stringify({
        roomId: "test",
        files: { "main.py": "print('hello')" },
        command: ["python3", "main.py"],
        language: "python",
      }),
    });
    console.log(`   2.2 Bad secret POST /execution/sandbox status: ${badSecretRes.status} (expected 401)`);
    if (badSecretRes.status !== 401) throw new Error(`Expected 401 for bad secret, got ${badSecretRes.status}`);

    // 2.3 Valid secret header passes auth
    const authRes = await fetch(`http://localhost:${API_PORT}/execution/sandbox`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": "codesync-internal-ai-secret",
      },
      body: JSON.stringify({
        roomId: "test-auth-pass",
        files: { "main.py": "print('SANDBOX_AUTH_OK')\n" },
        command: ["python3", "main.py"],
        language: "python",
      }),
    });
    console.log(`   2.3 Authenticated POST /execution/sandbox status: ${authRes.status} (expected 200)`);
    if (authRes.status !== 200) {
      const txt = await authRes.text();
      throw new Error(`Expected 200 for authenticated request, got ${authRes.status}: ${txt}`);
    }
    const authData = await authRes.json();
    console.log(`       Output: ${authData.stdout.trim()}`);
    if (!authData.stdout.includes("SANDBOX_AUTH_OK")) throw new Error("Expected sandbox execution output");

    // 2.4 Rate limit enforcement on sandbox endpoint (limit = 30)
    console.log("   2.4 Verifying sandbox rate limiter returns 429 when quota exceeded...");
    let hit429 = false;
    let requestCount = 0;
    for (let i = 0; i < 35; i++) {
      requestCount++;
      const rlRes = await fetch(`http://localhost:${API_PORT}/execution/sandbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "codesync-internal-ai-secret",
        },
        body: JSON.stringify({}), // returns 400 fast after rate limit middleware
      });
      if (rlRes.status === 429) {
        hit429 = true;
        console.log(`       Request ${i + 1} received 429 (rate limit enforced: Retry-After = ${rlRes.headers.get("Retry-After")})`);
        break;
      }
    }
    if (!hit429) throw new Error("Expected 429 after exceeding sandbox rate limit");
    // Reset sandbox rate limit key so subsequent tests have full quota
    await redis.del("ratelimit:sandbox:codesync-internal-ai-secret");
    console.log("   -> PASS: Item 2 verified (401 without auth, 200 with internal secret, 429 rate limit).\n");

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 3: Fallback Removal & API Down Behavior
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[Item 3] Testing that AI Service fails clearly if API is down (no direct-Docker fallback)...");

    const failDownProc = spawn(
      PYTHON_EXE,
      [
        "-c",
        `
import sys, json, os
sys.path.insert(0, r'${AI_DIR}')
os.environ['SANDBOX_URL'] = 'http://localhost:59999/execution/sandbox'  # dead port
from app.agent.graph import run_agent
from app.agent.llm_provider import MockLLMProvider
p = MockLLMProvider()
p.set_responses([json.dumps({"function_name": "calc", "new_code": "def calc(): return 1"})])
res = run_agent(
    room_id="fail-down-room",
    prompt="fix calc",
    base_text="def calc(): return 0",
    base_version="v1",
    language="python",
    file_path="calc.py",
    llm_provider=p,
)
print("AGENT_STATUS=" + res.get("status", ""))
print("AGENT_ERROR=" + str(res.get("error_message", "")))
`
      ],
      { stdio: "pipe" }
    );

    let failDownOutput = "";
    await new Promise<void>((resolve, reject) => {
      failDownProc.stdout?.on("data", (d) => (failDownOutput += d.toString()));
      failDownProc.stderr?.on("data", (d) => (failDownOutput += d.toString()));
      failDownProc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Process failed: ${failDownOutput}`));
      });
    });

    console.log(`   Output: ${failDownOutput.trim()}`);
    if (!failDownOutput.includes("AGENT_STATUS=error") || !failDownOutput.includes("Sandbox API unavailable")) {
      throw new Error(`Expected agent to fail clearly with status 'error' when API is down: ${failDownOutput}`);
    }
    console.log("   -> PASS: Item 3 verified (AI fails clearly when API is down; direct Docker removed).\n");

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: Connect real WebSocket client to Sync Service
    // ─────────────────────────────────────────────────────────────────────────
    const connectSyncClient = (doc: Y.Doc, uid: string): Promise<WebSocket> => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${SYNC_PORT}?token=test-token-${uid}&roomId=${roomId}`);
        ws.on("open", () => {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC
          syncProtocol.writeSyncStep1(encoder, doc);
          ws.send(encoding.toUint8Array(encoder));
        });

        ws.on("message", (raw: Buffer) => {
          const data = new Uint8Array(raw);
          const decoder = decoding.createDecoder(data);
          const msgType = decoding.readVarUint(decoder);
          if (msgType === 0) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, 0);
            const syncReply = syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
            if (encoding.length(encoder) > 1) {
              ws.send(encoding.toUint8Array(encoder));
            }
            if (syncReply === syncProtocol.messageYjsSyncStep2 || syncReply === 2) {
              resolve(ws);
            }
          }
        });

        doc.on("update", (update: Uint8Array, origin: any) => {
          if (origin !== ws) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, 0);
            syncProtocol.writeUpdate(encoder, update);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(encoding.toUint8Array(encoder));
            }
          }
        });

        ws.on("error", reject);
      });
    };

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 4 & ITEM 1: Two-Client WebSocket Collaboration & Accept Stale Rule
    //   baseVersion captured BEFORE B edits:
    //   (a) Client B edits DIFFERENT function -> 200 and B's edit survives.
    //   (b) Client B edits SAME function -> 409 and document unchanged.
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[Item 4 & 1] Real Two-Client WebSocket Collaboration & Accept Stale Rule...");

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const wsA = await connectSyncClient(docA, ownerId);
    const wsB = await connectSyncClient(docB, editorId);

    // Initial code in document
    const initialCode =
`def calculate_sum(a, b):
    return a - b

def format_greeting(name):
    return f"Hello, {name}!"
`;

    // Client A inserts initial code
    docA.getText("content").insert(0, initialCode);

    // Wait for sync to Client B
    await new Promise((r) => setTimeout(r, 800));

    // Confirm initial code synced to B
    console.log(`   Initial doc synced to Client B: len=${docB.getText("content").toString().length}`);

    // AI proposed fix for calculate_sum:
    const oldFnCode = "def calculate_sum(a, b):\n    return a - b";
    const fixedFnCode = "def calculate_sum(a, b):\n    return a + b";

    // ── Sub-test (a): baseVersion captured BEFORE B edits a DIFFERENT function ──
    console.log("   [4a] Capturing baseVersion BEFORE Client B edits...");
    const stateBeforeB = await (await fetch(`http://localhost:${SYNC_PORT}/room/${roomId}/state`)).json() as any;
    const baseVersionBeforeB = stateBeforeB.stateVector;

    const acceptInteractionA = await prisma.aIInteraction.create({
      data: {
        roomId,
        userId: ownerId,
        prompt: "Fix calculate_sum",
        baseVersion: baseVersionBeforeB,
        status: "pending",
      },
    });

    console.log("   Client B edits format_greeting (a different function) concurrently...");
    const oldGreeting = 'return f"Hello, {name}!"';
    const newGreeting = 'return f"Greetings, {name}!"';
    const bText = docB.getText("content").toString();
    const greetingIdx = bText.indexOf(oldGreeting);
    docB.getText("content").delete(greetingIdx, oldGreeting.length);
    docB.getText("content").insert(greetingIdx, newGreeting);

    // Wait for B's edit to propagate to server and Client A
    await new Promise((r) => setTimeout(r, 600));

    // Client A accepts the AI fix
    activeUser = ownerUser;
    const acceptResA = await fetch(`http://localhost:${API_PORT}/ai/${acceptInteractionA.id}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldRangeText: oldFnCode,
        newCode: fixedFnCode,
      }),
    });

    console.log(`   Accept response status: ${acceptResA.status} (expected 200)`);
    if (acceptResA.status !== 200) {
      const errText = await acceptResA.text();
      throw new Error(`Accept failed: ${acceptResA.status} - ${errText}`);
    }

    // Wait for sync broadcast
    await new Promise((r) => setTimeout(r, 600));

    const finalDocAfterA = docA.getText("content").toString();
    const finalDocB = docB.getText("content").toString();
    console.log("   Final doc content on Client A:\n" + finalDocAfterA.trim());

    // Assert: Fix was applied
    if (!finalDocAfterA.includes("return a + b")) {
      throw new Error("Accepted fix 'return a + b' missing from document!");
    }
    // Assert: Client B's concurrent edit to different function SURVIVED!
    if (!finalDocAfterA.includes("Greetings, {name}!")) {
      throw new Error("Client B's concurrent edit was clobbered by Accept!");
    }
    // Assert: Both clients match
    if (finalDocAfterA !== finalDocB) {
      throw new Error("Client A and Client B documents are out of sync!");
    }
    console.log("   -> PASS 4a: Different function edit survived; fix accepted with 200 and synced to both clients.\n");

    // ── Sub-test (b): baseVersion captured BEFORE B edits the SAME function ──
    console.log("   [4b] Capturing baseVersion BEFORE Client B edits the SAME function...");
    const stateBeforeB2 = await (await fetch(`http://localhost:${SYNC_PORT}/room/${roomId}/state`)).json() as any;
    const baseVersionBeforeB2 = stateBeforeB2.stateVector;

    const acceptInteractionB = await prisma.aIInteraction.create({
      data: {
        roomId,
        userId: ownerId,
        prompt: "Fix calculate_sum again",
        baseVersion: baseVersionBeforeB2,
        status: "pending",
      },
    });

    console.log("   Client B edits calculate_sum (the SAME function) concurrently...");
    const currentDocB = docB.getText("content").toString();
    const sumIdx = currentDocB.indexOf("return a + b");
    docB.getText("content").delete(sumIdx, "return a + b".length);
    docB.getText("content").insert(sumIdx, "return a * b  # manual edit by B");

    // Wait for B's edit to propagate
    await new Promise((r) => setTimeout(r, 600));

    const docBeforeConflictAttempt = docA.getText("content").toString();

    // Accept tries to apply with oldRangeText that no longer matches calculate_sum
    const conflictRes = await fetch(`http://localhost:${API_PORT}/ai/${acceptInteractionB.id}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldRangeText: "return a + b", // B just changed this to return a * b
        newCode: "return a ** b",
      }),
    });

    console.log(`   Conflicting Accept response status: ${conflictRes.status} (expected 409)`);
    if (conflictRes.status !== 409) {
      throw new Error(`Expected 409 on conflicting Accept, got ${conflictRes.status}`);
    }

    await new Promise((r) => setTimeout(r, 300));
    const docAfterConflictAttempt = docA.getText("content").toString();
    if (docBeforeConflictAttempt !== docAfterConflictAttempt) {
      throw new Error("Document was mutated during a rejected 409 Accept attempt!");
    }
    console.log("   -> PASS 4b: Conflicting edit on same function rejected with 409; document intact.\n");

    wsA.close();
    wsB.close();

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 5: Rewrite the Invariant Test
    //   Doc with real content, scripted mock LLM returning valid fix,
    //   real loop through real sandbox path (API/queue/worker),
    //   compare sync service state before and after loop (byte-identical),
    //   then show Accept applies!
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[Item 5] Testing Real Sync Invariant & Real Sandbox Path (Before Loop vs After Loop)...");

    const invariantRoomId = "invariant-room-" + uuidv4().slice(0, 8);
    await prisma.room.create({
      data: {
        id: invariantRoomId,
        title: "Invariant Room",
        ownerId: ownerId,
        defaultLang: "python",
        members: { create: [{ userId: ownerId, role: "OWNER" }] },
      },
    });

    // Populate room with REAL content via WebSocket
    const invDoc = new Y.Doc();
    const invWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${SYNC_PORT}?token=test-token-${ownerId}&roomId=${invariantRoomId}`);
      ws.on("open", () => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeSyncStep1(encoder, invDoc);
        ws.send(encoding.toUint8Array(encoder));
      });
      ws.on("message", (raw: Buffer) => {
        const data = new Uint8Array(raw);
        const decoder = decoding.createDecoder(data);
        const msgType = decoding.readVarUint(decoder);
        if (msgType === 0) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, 0);
          const syncReply = syncProtocol.readSyncMessage(decoder, encoder, invDoc, ws);
          if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
          if (syncReply === syncProtocol.messageYjsSyncStep2 || syncReply === 2) resolve(ws);
        }
      });
      invDoc.on("update", (update: Uint8Array, origin: any) => {
        if (origin !== ws) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, 0);
          syncProtocol.writeUpdate(encoder, update);
          if (ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(encoder));
        }
      });
      ws.on("error", reject);
    });

    const realDocContent =
`def multiply_numbers(x: int, y: int) -> int:
    """Return the product of x and y."""
    return x * y

def divide_numbers(x: int, y: int) -> int:
    """Return x divided by y (integer division)."""
    return x - y  # BUG: should be x // y
`;

    invDoc.getText("content").insert(0, realDocContent);
    await new Promise((r) => setTimeout(r, 800));

    // Capture sync state BEFORE loop
    const invResBefore = await fetch(`http://localhost:${SYNC_PORT}/room/${invariantRoomId}/state`);
    const invDataBefore = (await invResBefore.json()) as any;
    console.log(`   Doc seeded with real content (len=${invDataBefore.content.length})`);
    console.log(`   Initial Yjs stateVector: ${invDataBefore.stateVector.slice(0, 32)}...`);

    // Run LangGraph loop on isolated copy through REAL sandbox path
    console.log("   Running LangGraph loop through real API/worker sandbox path...");
    const realFixedFunc =
`def divide_numbers(x: int, y: int) -> int:
    """Return x divided by y (integer division)."""
    return x // y
`;
    const fixedJson = JSON.stringify({
      function_name: "divide_numbers",
      new_code: realFixedFunc,
    });

    const runnerCode = `
import sys, json, os
sys.path.insert(0, r'${AI_DIR}')
os.environ['SANDBOX_URL'] = 'http://localhost:${API_PORT}/execution/sandbox'
os.environ['INTERNAL_API_SECRET'] = 'codesync-internal-ai-secret'

from app.agent.graph import run_agent
from app.agent.llm_provider import MockLLMProvider

provider = MockLLMProvider()
provider.set_responses([${JSON.stringify(fixedJson)}])

test_script = """
import main
assert main.multiply_numbers(3, 4) == 12
assert main.divide_numbers(10, 2) == 5
print("ALL INVARIANT TESTS PASSED")
"""

res = run_agent(
    room_id="${invariantRoomId}",
    prompt="Fix divide_numbers bug",
    base_text=${JSON.stringify(realDocContent)},
    base_version="${invDataBefore.stateVector}",
    language="python",
    file_path="main.py",
    test_command=["python3", "test_main.py"],
    extra_files={"test_main.py": test_script},
    llm_provider=provider,
)

print("AGENT_STATUS=" + res.get("status", ""))
print("AGENT_CALLS=" + str(res.get("llm_calls", 0)))
print("ORIGINAL_CODE=" + repr(res.get("original_code", "")))
print("NEW_CODE=" + repr(res.get("new_code", "")))
`;

    const realLoopProc = spawn(
      PYTHON_EXE,
      ["-c", runnerCode],
      { stdio: "pipe" }
    );

    let realLoopOut = "";
    await new Promise<void>((resolve, reject) => {
      realLoopProc.stdout?.on("data", (d) => (realLoopOut += d.toString()));
      realLoopProc.stderr?.on("data", (d) => (realLoopOut += d.toString()));
      realLoopProc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Real loop runner failed with code ${code}: ${realLoopOut}`));
      });
    });

    console.log(`   Agent execution output:\n${realLoopOut.trim()}`);
    if (!realLoopOut.includes("AGENT_STATUS=verified")) {
      throw new Error(`Agent failed to verify fix via real sandbox path: ${realLoopOut}`);
    }

    // Capture sync state AFTER loop (before Accept)
    const invResAfter = await fetch(`http://localhost:${SYNC_PORT}/room/${invariantRoomId}/state`);
    const invDataAfter = (await invResAfter.json()) as any;

    console.log(`   Yjs stateVector before loop: ${invDataBefore.stateVector}`);
    console.log(`   Yjs stateVector after loop:  ${invDataAfter.stateVector}`);

    if (invDataBefore.stateVector !== invDataAfter.stateVector) {
      throw new Error("INVARIANT VIOLATION: Sync service Yjs stateVector mutated during AI loop!");
    }
    if (invDataBefore.content !== invDataAfter.content) {
      throw new Error("INVARIANT VIOLATION: Sync service document content mutated during AI loop!");
    }
    console.log("   -> Invariant preserved: Document completely untouched before Accept.");

    // Now show Accept applies!
    console.log("   Now applying Accept via PATCH /ai/:id/accept...");
    const invInteraction = await prisma.aIInteraction.create({
      data: {
        roomId: invariantRoomId,
        userId: ownerId,
        prompt: "Fix divide_numbers bug",
        baseVersion: invDataBefore.stateVector,
        status: "pending",
      },
    });

    const oldRangeToReplace =
`def divide_numbers(x: int, y: int) -> int:
    """Return x divided by y (integer division)."""
    return x - y  # BUG: should be x // y`;

    activeUser = ownerUser;
    const invAcceptRes = await fetch(`http://localhost:${API_PORT}/ai/${invInteraction.id}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldRangeText: oldRangeToReplace,
        newCode: realFixedFunc.trim(),
      }),
    });

    console.log(`   Accept response status: ${invAcceptRes.status} (expected 200)`);
    if (invAcceptRes.status !== 200) {
      const err = await invAcceptRes.text();
      throw new Error(`Accept failed: ${invAcceptRes.status} - ${err}`);
    }

    await new Promise((r) => setTimeout(r, 600));

    // Verify document in sync service now contains the fix
    const invResFinal = await fetch(`http://localhost:${SYNC_PORT}/room/${invariantRoomId}/state`);
    const invDataFinal = (await invResFinal.json()) as any;
    console.log("   Final document after Accept:\n" + invDataFinal.content.trim());

    if (!invDataFinal.content.includes("return x // y")) {
      throw new Error("Accepted fix 'return x // y' missing from final document!");
    }
    if (!invDataFinal.content.includes("multiply_numbers")) {
      throw new Error("Existing function 'multiply_numbers' was lost!");
    }
    if (invDataFinal.stateVector === invDataBefore.stateVector) {
      throw new Error("StateVector should have updated after Accept was applied!");
    }
    console.log("   -> PASS: Item 5 verified (Document invariant holds during loop; Accept applies cleanly).\n");

    invWs.close();

    console.log("=========================================================================");
    console.log("               ALL CLOSEOUT TESTS COMPLETED SUCCESSFULLY                 ");
    console.log("=========================================================================\n");

  } finally {
    if (apiServer) (apiServer as any).close();
    killProcessTree(syncProcess);
    killProcessTree(workerProcess);
    await redis.quit();
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("FATAL ERROR:", err);
    process.exit(1);
  });
