process.env.NODE_ENV = "test";
process.env.INTERNAL_API_SECRET = "codesync-internal-ai-secret";

import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import express from "express";
import http from "http";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { prisma } from "../services/api/src/lib/prisma";
import aiRouter from "../services/api/src/routes/ai";
import executionRouter from "../services/api/src/routes/execution";

const SYNC_DIST = path.resolve(__dirname, "../services/sync/dist/index.js");
const WORKER_DIST = path.resolve(__dirname, "../services/worker/dist/index.js");
const PYTHON_EXE = path.resolve(__dirname, "../services/ai/.venv/Scripts/python.exe");
const AI_DIR = path.resolve(__dirname, "../services/ai");

const SYNC_PORT = 4195;
const API_PORT = 4196;
const AI_MOCK_PORT = 4197;
const INTERNAL_SECRET = "codesync-internal-ai-secret";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");

function killProc(proc: ChildProcess | null) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {}
}

function connectYjsWs(port: number, roomId: string, token: string): Promise<{ ws: WebSocket; doc: Y.Doc }> {
  const doc = new Y.Doc();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}?token=${token}&roomId=${roomId}`);

    ws.on("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
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
          resolve({ ws, doc });
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
}

async function main() {
  console.log("=========================================================================");
  console.log("       CodeSync Phase 5: Verification of All 5 New Requirements          ");
  console.log("=========================================================================\n");

  let syncProcess: ChildProcess | null = null;
  let workerProcess: ChildProcess | null = null;
  let apiServer: http.Server | null = null;
  let aiMockServer: http.Server | null = null;

  try {
    // Clean Redis queue and rate limits
    console.log("[Setup] Resetting Redis queue and rate limit state...");
    const oldKeys = await redis.keys("bull:code_execution:*");
    if (oldKeys.length > 0) await redis.del(...oldKeys);
    const rlKeys = await redis.keys("ratelimit:*");
    if (rlKeys.length > 0) await redis.del(...rlKeys);
    console.log("   -> Redis queue and rate limits clean.\n");

    // 0. Start Sync Service
    console.log(`[Setup] Starting Sync Service on port ${SYNC_PORT}...`);
    await new Promise<void>((resolve, reject) => {
      syncProcess = spawn("node", [SYNC_DIST], {
        env: {
          ...process.env,
          SYNC_PORT: String(SYNC_PORT),
          PORT: String(SYNC_PORT),
          INTERNAL_API_SECRET: INTERNAL_SECRET,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      syncProcess.stdout?.on("data", (d) => {
        if (d.toString().includes(`:${SYNC_PORT}`)) resolve();
      });
      syncProcess.on("error", reject);
      setTimeout(resolve, 3000);
    });
    console.log("   -> Sync service running.\n");

    // 0b. Start Worker Service
    console.log("[Setup] Starting Worker Service for sandbox jobs...");
    workerProcess = spawn("node", [WORKER_DIST], {
      env: {
        ...process.env,
        REDIS_URL: process.env.REDIS_URL || "redis://localhost:6380",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((r) => setTimeout(r, 2000));
    console.log("   -> Worker service running.\n");

    // 0c. Start API Service
    console.log(`[Setup] Starting API Service on port ${API_PORT}...`);
    let activeUser: any = null;
    const apiApp = express();
    apiApp.use(express.json({ limit: "2mb" }));
    apiApp.use((req, _res, next) => {
      if (activeUser) req.user = activeUser;
      next();
    });

    process.env.SYNC_SERVICE_URL = `http://localhost:${SYNC_PORT}`;
    process.env.AI_SERVICE_URL = `http://localhost:${AI_MOCK_PORT}`;
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;

    apiApp.use("/ai", aiRouter);
    apiApp.use("/execution", executionRouter);

    await new Promise<void>((resolve) => {
      apiServer = apiApp.listen(API_PORT, () => resolve());
    });
    console.log("   -> API service running.\n");

    // Seed test users & room
    const ownerId = "owner-" + uuidv4().slice(0, 8);
    const editorId = "editor-" + uuidv4().slice(0, 8);
    const viewerId = "viewer-" + uuidv4().slice(0, 8);
    const testRoomId = "room-req-" + uuidv4().slice(0, 8);

    await prisma.user.createMany({
      data: [
        { id: ownerId, email: `${ownerId}@test.com`, name: "Owner User" },
        { id: editorId, email: `${editorId}@test.com`, name: "Editor User" },
        { id: viewerId, email: `${viewerId}@test.com`, name: "Viewer User" },
      ],
    });

    await prisma.room.create({
      data: {
        id: testRoomId,
        title: "Test Room Requirements",
        ownerId,
        members: {
          create: [
            { userId: ownerId, role: "OWNER" },
            { userId: editorId, role: "EDITOR" },
            { userId: viewerId, role: "VIEWER" },
          ],
        },
      },
    });

    activeUser = { id: ownerId, email: `${ownerId}@test.com` };

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 2: Sync Service HTTP Routes Auth & CORS Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log("-------------------------------------------------------------------------");
    console.log("  ITEM 2: Sync service HTTP routes auth & CORS verification               ");
    console.log("-------------------------------------------------------------------------");

    // 2a. Call /room/:id/state without header -> 401
    const unauthRes1 = await fetch(`http://localhost:${SYNC_PORT}/room/${testRoomId}/state`);
    console.log(`   GET /room/${testRoomId}/state without header: ${unauthRes1.status} (expected 401)`);
    if (unauthRes1.status !== 401) throw new Error(`Expected 401 on unauthenticated /state, got ${unauthRes1.status}`);

    // 2b. Call /room/:id/text without header -> 401
    const unauthRes2 = await fetch(`http://localhost:${SYNC_PORT}/room/${testRoomId}/text`);
    console.log(`   GET /room/${testRoomId}/text without header: ${unauthRes2.status} (expected 401)`);
    if (unauthRes2.status !== 401) throw new Error(`Expected 401 on unauthenticated /text, got ${unauthRes2.status}`);

    // 2c. Call /room/:id/apply-patch without header -> 401
    const unauthRes3 = await fetch(`http://localhost:${SYNC_PORT}/room/${testRoomId}/apply-patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldRangeText: "abc", newCode: "xyz" }),
    });
    console.log(`   POST /room/${testRoomId}/apply-patch without header: ${unauthRes3.status} (expected 401)`);
    if (unauthRes3.status !== 401) throw new Error(`Expected 401 on unauthenticated /apply-patch, got ${unauthRes3.status}`);

    // 2d. Call with header -> 200 and check CORS header is absent
    const authRes = await fetch(`http://localhost:${SYNC_PORT}/room/${testRoomId}/state`, {
      headers: { "x-internal-secret": INTERNAL_SECRET },
    });
    console.log(`   GET /room/${testRoomId}/state with x-internal-secret: ${authRes.status} (expected 200)`);
    if (authRes.status !== 200) throw new Error(`Expected 200 with x-internal-secret, got ${authRes.status}`);

    const corsHeader = authRes.headers.get("access-control-allow-origin");
    console.log(`   CORS Access-Control-Allow-Origin header: ${corsHeader ?? "none"} (expected none)`);
    if (corsHeader === "*") throw new Error("CORS Access-Control-Allow-Origin: * must be removed");

    console.log("   -> PASS: Item 2 verified (401 without secret, 200 with secret, CORS * removed).\n");

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 3: Atomic Stale Check & 503 on Text Fetch Failure
    // ─────────────────────────────────────────────────────────────────────────
    console.log("-------------------------------------------------------------------------");
    console.log("  ITEM 3: Atomic Stale Check in Yjs Transaction & 503 on Fetch Failure   ");
    console.log("-------------------------------------------------------------------------");

    // Seed document with known text via WebSocket
    const { ws: wsSeed, doc: docSeed } = await connectYjsWs(SYNC_PORT, testRoomId, `test-token-${ownerId}`);
    const seedCode = "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n";
    docSeed.getText("content").insert(0, seedCode);
    await new Promise((r) => setTimeout(r, 600));

    // 3a. apply-patch with non-matching oldRangeText -> 409
    const atomicMismatchRes = await fetch(`http://localhost:${SYNC_PORT}/room/${testRoomId}/apply-patch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({
        oldRangeText: "def nonexistent(): pass\n",
        newCode: "def nonexistent(): return 42\n",
      }),
    });
    console.log(`   apply-patch with missing oldRangeText: ${atomicMismatchRes.status} (expected 409)`);
    if (atomicMismatchRes.status !== 409) throw new Error(`Expected 409, got ${atomicMismatchRes.status}`);
    const mismatchBody = await atomicMismatchRes.json();
    console.log(`   Error message: "${mismatchBody.error}"`);

    // 3b. 503 on text fetch failure in /accept
    // Temporarily point SYNC_SERVICE_URL to a dead port
    const originalSyncUrl = process.env.SYNC_SERVICE_URL;
    process.env.SYNC_SERVICE_URL = "http://localhost:59999"; // guaranteed dead port

    const dummyInteraction = await prisma.aIInteraction.create({
      data: {
        roomId: testRoomId,
        userId: ownerId,
        prompt: "test",
        baseVersion: "latest",
        status: "verified",
      },
    });

    const textFailRes = await fetch(`http://localhost:${API_PORT}/ai/${dummyInteraction.id}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldRangeText: "def add(a, b):",
        newCode: "def add(a, b): return a + b",
      }),
    });
    console.log(`   PATCH /accept when sync text fetch fails: ${textFailRes.status} (expected 503)`);
    if (textFailRes.status !== 503) throw new Error(`Expected 503 when text fetch fails, got ${textFailRes.status}`);
    const failBody = await textFailRes.json();
    console.log(`   503 Error response: "${failBody.error}"`);

    // Restore SYNC_SERVICE_URL
    process.env.SYNC_SERVICE_URL = originalSyncUrl;
    wsSeed.close();
    console.log("   -> PASS: Item 3 verified (Atomic check in transact() returned 409, fetch fail returned 503).\n");

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 4: Role re-check, code-size cap, testCommand allowlist, AI fail
    // ─────────────────────────────────────────────────────────────────────────
    console.log("-------------------------------------------------------------------------");
    console.log("  ITEM 4: Role Re-Check, Code Cap, testCommand Allowlist, AI Fail Status ");
    console.log("-------------------------------------------------------------------------");

    // 4a. Code size cap: >100 KB -> 413
    const bigCode = "a".repeat(101 * 1024);
    const capRes = await fetch(`http://localhost:${API_PORT}/ai/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: testRoomId,
        code: bigCode,
        prompt: "Fix big code",
      }),
    });
    console.log(`   POST /ai/fix with code > 100 KB: ${capRes.status} (expected 413)`);
    if (capRes.status !== 413) throw new Error(`Expected 413 on oversized code, got ${capRes.status}`);

    // 4b. testCommand allowlist check: disallowed command -> 400
    const disallowedRes = await fetch(`http://localhost:${API_PORT}/ai/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: testRoomId,
        code: "def foo(): pass",
        prompt: "Fix foo",
        testCommand: ["rm", "-rf", "/"],
      }),
    });
    console.log(`   POST /ai/fix with disallowed testCommand ["rm", "-rf", "/"]: ${disallowedRes.status} (expected 400)`);
    if (disallowedRes.status !== 400) throw new Error(`Expected 400 on disallowed testCommand, got ${disallowedRes.status}`);

    const shellChainRes = await fetch(`http://localhost:${API_PORT}/ai/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: testRoomId,
        code: "def foo(): pass",
        prompt: "Fix foo",
        testCommand: "python3 test.py; cat /etc/passwd",
      }),
    });
    console.log(`   POST /ai/fix with shell chaining: ${shellChainRes.status} (expected 400)`);
    if (shellChainRes.status !== 400) throw new Error(`Expected 400 on chained testCommand, got ${shellChainRes.status}`);

    // 4c. AI service call throws/fails -> interaction status marked "failed"
    // Currently AI service on 4197 is not running, so fetch throws
    const throwRes = await fetch(`http://localhost:${API_PORT}/ai/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: testRoomId,
        code: "def foo(): pass",
        prompt: "Fix foo",
        testCommand: ["python3", "test_foo.py"],
      }),
    });
    console.log(`   POST /ai/fix when AI service is down: ${throwRes.status} (expected 500)`);
    if (throwRes.status !== 500) throw new Error(`Expected 500 on AI call failure, got ${throwRes.status}`);

    // Verify interaction in DB is marked "failed"
    const failedInteraction = await prisma.aIInteraction.findFirst({
      where: { roomId: testRoomId, prompt: "Fix foo" },
      orderBy: { createdAt: "desc" },
    });
    console.log(`   Interaction record status in DB: "${failedInteraction?.status}" (expected "failed")`);
    if (failedInteraction?.status !== "failed") {
      throw new Error(`Expected status 'failed', got '${failedInteraction?.status}'`);
    }

    // 4d. /accept role re-check: VIEWER cannot accept -> 403
    activeUser = { id: viewerId, email: `${viewerId}@test.com` };
    const viewerAcceptRes = await fetch(`http://localhost:${API_PORT}/ai/${dummyInteraction.id}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldRangeText: "def add(a, b):",
        newCode: "def add(a, b): return a + b",
      }),
    });
    console.log(`   PATCH /accept by VIEWER: ${viewerAcceptRes.status} (expected 403)`);
    if (viewerAcceptRes.status !== 403) throw new Error(`Expected 403 for VIEWER, got ${viewerAcceptRes.status}`);

    activeUser = { id: ownerId, email: `${ownerId}@test.com` };
    console.log("   -> PASS: Item 4 verified (Code cap 413, allowlist 400, AI throw marked 'failed', VIEWER 403).\n");

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 1: Interaction Statuses & End-to-End Fix -> Accept -> Second Client
    // ─────────────────────────────────────────────────────────────────────────
    console.log("-------------------------------------------------------------------------");
    console.log("  ITEM 1: Interaction Statuses & End-to-End Test (Real Sandbox + Accept) ");
    console.log("-------------------------------------------------------------------------");

    // Start mock AI Service on AI_MOCK_PORT that delegates to the real LangGraph agent
    const aiMockApp = express();
    aiMockApp.use(express.json());

    const buggyCode =
`def multiply(x: int, y: int) -> int:
    """Return product of x and y."""
    return x * y

def divide(x: int, y: int) -> int:
    """Return integer division of x by y."""
    return x - y  # BUG: should be x // y
`;

    const fixCode =
`def divide(x: int, y: int) -> int:
    """Return integer division of x by y."""
    return x // y
`;

    const originalFunc =
`def divide(x: int, y: int) -> int:
    """Return integer division of x by y."""
    return x - y  # BUG: should be x // y
`;

    aiMockApp.post("/fix", async (req, res) => {
      // Execute LangGraph agent through Python script using real sandbox path
      const runnerCode = `
import sys, json, os
sys.path.insert(0, r'${AI_DIR}')
os.environ['SANDBOX_URL'] = 'http://localhost:${API_PORT}/execution/sandbox'
os.environ['INTERNAL_API_SECRET'] = 'codesync-internal-ai-secret'

from app.agent.graph import run_agent
from app.agent.llm_provider import MockLLMProvider

fixed_json = json.dumps({
    "function_name": "divide",
    "new_code": ${JSON.stringify(fixCode)},
})

provider = MockLLMProvider()
provider.set_responses([fixed_json])

res = run_agent(
    room_id="${testRoomId}",
    prompt=${JSON.stringify(req.body.prompt)},
    base_text=${JSON.stringify(req.body.code)},
    base_version=${JSON.stringify(req.body.base_version)},
    language="python",
    file_path="calc.py",
    test_command=${JSON.stringify(req.body.test_command)},
    extra_files=${JSON.stringify(req.body.extra_files || {})},
    llm_provider=provider,
)

print(json.dumps({
    "status": res.get("status"),
    "patch": res.get("diff_patch", ""),
    "patched_text": res.get("patched_text", ""),
    "original_code": res.get("original_code", ""),
    "new_code": res.get("new_code", ""),
    "function_name": res.get("function_name"),
    "llm_calls": res.get("llm_calls", 0),
    "total_cost_usd": res.get("total_cost_usd", 0.0),
}))
`;
      const p = spawn(PYTHON_EXE, ["-c", runnerCode], { stdio: "pipe" });
      let out = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (out += d.toString()));
      p.on("close", (code) => {
        if (code === 0) {
          const lines = out.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          res.json(JSON.parse(lastLine));
        } else {
          res.status(500).json({ error: out });
        }
      });
    });

    await new Promise<void>((resolve) => {
      aiMockServer = aiMockApp.listen(AI_MOCK_PORT, () => resolve());
    });
    console.log("   -> AI Service initialized on port", AI_MOCK_PORT);

    // Seed document with buggyCode
    const e2eRoomId = "room-e2e-" + uuidv4().slice(0, 8);
    await prisma.room.create({
      data: {
        id: e2eRoomId,
        title: "E2E Room",
        ownerId,
        members: {
          create: [
            { userId: ownerId, role: "OWNER" },
            { userId: editorId, role: "EDITOR" },
          ],
        },
      },
    });

    // Client B connects via WebSocket
    console.log("   Client B connecting to Yjs sync service via WebSocket...");
    const { ws: wsB, doc: docB } = await connectYjsWs(SYNC_PORT, e2eRoomId, `test-token-${editorId}`);

    // Client A seeds document
    const { ws: wsA, doc: docA } = await connectYjsWs(SYNC_PORT, e2eRoomId, `test-token-${ownerId}`);
    docA.getText("content").insert(0, buggyCode);

    // Wait for sync to Client B
    await new Promise((r) => setTimeout(r, 800));
    console.log(`   Client B received synced content (len=${docB.getText("content").length})`);

    // Client A requests AI fix
    console.log("   Client A calling POST /ai/fix (mock provider, real sandbox execution)...");
    const testScript =
`import calc
assert calc.multiply(4, 5) == 20
assert calc.divide(20, 4) == 5
print("ALL TESTS PASSED")
`;
    activeUser = { id: ownerId, email: `${ownerId}@test.com` };
    const fixRes = await fetch(`http://localhost:${API_PORT}/ai/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: e2eRoomId,
        code: buggyCode,
        prompt: "Fix integer division bug in divide()",
        language: "python",
        filePath: "calc.py",
        testCommand: ["python3", "test_calc.py"],
        extraFiles: { "test_calc.py": testScript },
      }),
    });

    if (!fixRes.ok) throw new Error(`POST /ai/fix failed: ${fixRes.status} ${await fixRes.text()}`);
    const fixData = await fixRes.json();
    console.log(`   POST /ai/fix result: status="${fixData.status}", interactionId="${fixData.interactionId}"`);
    if (fixData.status !== "verified") throw new Error(`Expected status 'verified', got ${fixData.status}`);

    const interactionRecord = await prisma.aIInteraction.findUnique({ where: { id: fixData.interactionId } });
    console.log(`   Interaction DB status before accept: "${interactionRecord?.status}"`);
    if (interactionRecord?.status !== "verified") throw new Error("Expected DB status 'verified'");

    // Status constraint tests: Cannot accept from invalid statuses
    console.log("   Testing /accept status restrictions...");
    // Create interactions with invalid statuses
    const staleInt = await prisma.aIInteraction.create({
      data: { roomId: e2eRoomId, userId: ownerId, prompt: "t", baseVersion: "v", status: "stale" },
    });
    const rejInt = await prisma.aIInteraction.create({
      data: { roomId: e2eRoomId, userId: ownerId, prompt: "t", baseVersion: "v", status: "rejected" },
    });
    const accInt = await prisma.aIInteraction.create({
      data: { roomId: e2eRoomId, userId: ownerId, prompt: "t", baseVersion: "v", status: "accepted" },
    });

    const resStale = await fetch(`http://localhost:${API_PORT}/ai/${staleInt.id}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldRangeText: "foo", newCode: "bar" }),
    });
    console.log(`   /accept from 'stale' status: ${resStale.status} (expected 409)`);
    if (resStale.status !== 409) throw new Error(`Expected 409, got ${resStale.status}`);

    const resRej = await fetch(`http://localhost:${API_PORT}/ai/${rejInt.id}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldRangeText: "foo", newCode: "bar" }),
    });
    console.log(`   /accept from 'rejected' status: ${resRej.status} (expected 409)`);
    if (resRej.status !== 409) throw new Error(`Expected 409, got ${resRej.status}`);

    // Now Accept the verified interaction with returned original_code and new_code!
    console.log("   Client A calling PATCH /ai/:id/accept with returned original_code and new_code...");
    const acceptRes = await fetch(`http://localhost:${API_PORT}/ai/${fixData.interactionId}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldRangeText: fixData.original_code,
        newCode: fixData.new_code,
      }),
    });

    console.log(`   PATCH /accept response status: ${acceptRes.status} (expected 200)`);
    if (acceptRes.status !== 200) throw new Error(`Expected 200 on accept, got ${acceptRes.status}: ${await acceptRes.text()}`);

    const acceptedRecord = await prisma.aIInteraction.findUnique({ where: { id: fixData.interactionId } });
    console.log(`   Interaction DB status after accept: "${acceptedRecord?.status}" (expected "accepted")`);
    if (acceptedRecord?.status !== "accepted") throw new Error("Expected DB status 'accepted'");

    // Wait for Yjs update to propagate to Client B
    await new Promise((r) => setTimeout(r, 800));
    const clientBText = docB.getText("content").toString();
    console.log("   Verifying Client B's shared document received the update in real time:");
    console.log("   --- Client B Document Snapshot ---");
    console.log(clientBText.trim());
    console.log("   ----------------------------------");

    if (!clientBText.includes("return x // y")) {
      throw new Error("Client B document does NOT contain the accepted fix!");
    }
    if (clientBText.includes("return x - y")) {
      throw new Error("Client B document still contains buggy code!");
    }

    // Calling /accept again must return 409 because status is now "accepted"
    const secondAcceptRes = await fetch(`http://localhost:${API_PORT}/ai/${fixData.interactionId}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldRangeText: fixData.original_code,
        newCode: fixData.new_code,
      }),
    });
    console.log(`   Second /accept on already-accepted interaction: ${secondAcceptRes.status} (expected 409)`);
    if (secondAcceptRes.status !== 409) throw new Error(`Expected 409 on already-accepted, got ${secondAcceptRes.status}`);

    wsA.close();
    wsB.close();
    console.log("   -> PASS: Item 1 verified (E2E fix->accept->client B updated, statuses enforced).\n");

    // ─────────────────────────────────────────────────────────────────────────
    // ITEM 5: API Startup Throw on Live Clerk Key with NODE_ENV=test
    // ─────────────────────────────────────────────────────────────────────────
    console.log("-------------------------------------------------------------------------");
    console.log("  ITEM 5: API Startup Safety Check                                       ");
    console.log("-------------------------------------------------------------------------");

    console.log("   Spawning API service subprocess with NODE_ENV=test and live Clerk key...");
    let startupOutput = "";
    let startupExitCode: number | null = null;

    try {
      execSync(
        `node -e "process.env.NODE_ENV = 'test'; process.env.CLERK_SECRET_KEY = 'sk_live_1234567890abcdef'; require('./services/api/dist/index.js');"`,
        { stdio: "pipe", cwd: path.resolve(__dirname, "..") }
      );
      startupExitCode = 0;
    } catch (err: any) {
      startupExitCode = err.status ?? 1;
      startupOutput = (err.stdout?.toString() || "") + (err.stderr?.toString() || "") + (err.message || "");
    }

    console.log(`   API startup exited with code: ${startupExitCode} (expected non-zero)`);
    console.log(`   Startup error output:`);
    console.log(`   ${startupOutput.split("\n").filter((l) => l.includes("FATAL") || l.includes("Error:")).join("\n   ")}`);

    if (startupExitCode === 0) {
      throw new Error("API startup should have thrown with live Clerk key in test environment!");
    }
    if (!startupOutput.includes("FATAL: Live Clerk secret key detected in test environment")) {
      throw new Error("Missing expected fatal error message from API startup!");
    }

    console.log("   -> PASS: Item 5 verified (API throws immediately on live Clerk key during test).\n");

    console.log("=========================================================================");
    console.log("        ALL 5 PHASE 5 REQUIREMENTS VERIFIED AND PASSED SUCCESSFULLY      ");
    console.log("=========================================================================\n");

  } finally {
    if (apiServer) apiServer.close();
    if (aiMockServer) aiMockServer.close();
    killProc(syncProcess);
    killProc(workerProcess);
    await redis.quit();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("\nFATAL ERROR RUNNING REQUIREMENTS VERIFICATION:", err);
  process.exit(1);
});

