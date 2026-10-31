import express from "express";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import executionRouter from "../services/api/src/routes/execution";
import { prisma } from "../services/api/src/lib/prisma";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");


async function runApiVerification() {
  console.log("=============================================================");
  console.log("             Verifying API Limits and RBAC                   ");
  console.log("=============================================================\n");

  const ownerId = "test-owner-" + uuidv4().slice(0, 8);
  const editorId = "test-editor-" + uuidv4().slice(0, 8);
  const viewerId = "test-viewer-" + uuidv4().slice(0, 8);
  const roomId = "test-room-" + uuidv4().slice(0, 8);

  // Setup users in DB
  await prisma.user.createMany({
    data: [
      { id: ownerId, email: `${ownerId}@test.com`, name: "Owner" },
      { id: editorId, email: `${editorId}@test.com`, name: "Editor" },
      { id: viewerId, email: `${viewerId}@test.com`, name: "Viewer" },
    ],
  });

  // Setup room with memberships
  await prisma.room.create({
    data: {
      id: roomId,
      title: "Test Room",
      ownerId: ownerId,
      members: {
        create: [
          { userId: ownerId, role: "OWNER" },
          { userId: editorId, role: "EDITOR" },
          { userId: viewerId, role: "VIEWER" },
        ],
      },
    },
  });

  // Clear rate limits for test users in Redis
  await redis.del(`ratelimit:${editorId}:execution`);
  await redis.del(`ratelimit:${viewerId}:execution`);

  // Build Express app with mocked auth context
  let currentUserId: string | null = null;

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(async (req, _res, next) => {
    if (currentUserId) {
      req.user = (await prisma.user.findUnique({ where: { id: currentUserId } })) as any;
    }
    next();
  });
  app.use("/execution", executionRouter);

  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://localhost:${address.port}/execution`;

  try {
    // 1. Test VIEWER gets 403 Forbidden
    currentUserId = viewerId;
    const viewerRes = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, code: "print('viewer')", language: "python" }),
    });

    console.log(`[Test 1] Viewer execution status: ${viewerRes.status} (Expected: 403)`);
    if (viewerRes.status !== 403) {
      throw new Error(`Expected viewer to get 403, got ${viewerRes.status}`);
    }

    // 2. Test EDITOR gets 200 (allowed)
    currentUserId = editorId;
    const editorRes = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, code: "print('editor')", language: "python" }),
    });

    const editorBody: any = await editorRes.json();
    console.log(`[Test 2] Editor 1st run status: ${editorRes.status} (Expected: 200, jobId: ${editorBody.jobId})`);
    if (editorRes.status !== 200 || !editorBody.jobId) {
      throw new Error(`Expected editor to get 200, got ${editorRes.status}`);
    }

    // 3. Test Rate Limiting: 10 runs per minute per user, 11th gets 429
    console.log("\n[Test 3] Testing 10 runs per minute rate limit for Editor...");
    for (let i = 2; i <= 10; i++) {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, code: `print('run ${i}')`, language: "python" }),
      });
      if (res.status !== 200) {
        throw new Error(`Run ${i} failed unexpectedly with status ${res.status}`);
      }
    }
    console.log("Successfully completed 10 runs in 1 minute window.");

    // 11th run must get 429 with Retry-After header
    const run11Res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, code: "print('run 11')", language: "python" }),
    });

    const retryAfterHeader = run11Res.headers.get("retry-after");
    const run11Body = await run11Res.json();
    console.log(`Run 11 response status: ${run11Res.status} (Expected: 429)`);
    console.log(`Run 11 Retry-After header: ${retryAfterHeader}`);
    console.log(`Run 11 response body:`, run11Body);

    if (run11Res.status !== 429) {
      throw new Error(`Expected 11th run to get 429, got ${run11Res.status}`);
    }
    if (!retryAfterHeader) {
      throw new Error("Expected Retry-After header to be present on 429 response");
    }

    // 4. Test code over 100 KB rejected with 413
    await redis.del(`ratelimit:${editorId}:execution`);
    const largeCode = "x = 1\n".repeat(25000); // ~150 KB
    const largeRes = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, code: largeCode, language: "python" }),
    });

    console.log(`\n[Test 4] Code > 100KB response status: ${largeRes.status} (Expected: 413)`);
    if (largeRes.status !== 413) {
      throw new Error(`Expected large code to get 413, got ${largeRes.status}`);
    }

    console.log("\nAll API Limit and RBAC verifications PASSED successfully!");
  } finally {
    server.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  }
}

runApiVerification().catch((e) => {
  console.error("API verification error:", e);
  process.exit(1);
});
