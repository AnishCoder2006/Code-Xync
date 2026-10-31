process.env.NODE_ENV = "test";

import { spawn, ChildProcess, execSync } from "child_process";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import aiRouter from "../services/api/src/routes/ai";
import { prisma } from "../services/api/src/lib/prisma";

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

async function waitForHealth(url: string, timeoutMs: number = 25000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function runApiSearchTest() {
  console.log("=============================================================");
  console.log("     Verifying API Service Search Route & RBAC Member Check  ");
  console.log("=============================================================\n");

  const aiUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
  let aiProcess: ChildProcess | null = null;

  console.log(`[Step 1] Checking AI service at ${aiUrl}...`);
  const alreadyHealthy = await waitForHealth(aiUrl, 1500);
  if (alreadyHealthy) {
    console.log(`AI service is already running and healthy at ${aiUrl}.`);
  } else {
    console.log(`Starting AI service on port 8000...`);
    aiProcess = spawn("..\\services\\ai\\.venv\\Scripts\\python.exe", ["-m", "uvicorn", "app.main:app", "--port", "8000"], {
      cwd: "services/ai",
      stdio: "pipe",
      shell: true,
    });

    const isHealthy = await waitForHealth(aiUrl, 25000);
    if (!isHealthy) {
      throw new Error(`AI service failed to become healthy at ${aiUrl} within 25 seconds.`);
    }
    console.log(`AI service started and healthy at ${aiUrl}.`);
  }

  const ownerId = "test-owner-" + uuidv4().slice(0, 8);
  const outsiderId = "test-outsider-" + uuidv4().slice(0, 8);
  const roomId = "test-room-" + uuidv4().slice(0, 8);

  // 2. Setup user and room in DB
  await prisma.user.createMany({
    data: [
      { id: ownerId, email: `${ownerId}@test.com`, name: "Owner" },
      { id: outsiderId, email: `${outsiderId}@test.com`, name: "Outsider" },
    ],
  });

  await prisma.room.create({
    data: {
      id: roomId,
      title: "Search Auth Room",
      ownerId: ownerId,
      members: {
        create: [{ userId: ownerId, role: "OWNER" }],
      },
    },
  });

  // 3. Build express app with mocked auth context
  let currentUserId: string | null = null;
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    try {
      if (currentUserId) {
        req.user = (await prisma.user.findUnique({ where: { id: currentUserId } })) as any;
      }
      next();
    } catch (e) {
      next(e);
    }
  });
  app.use("/ai", aiRouter);
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("EXPRESS UNHANDLED ERROR:", err);
    res.status(500).json({ error: err.message, stack: err.stack });
  });

  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://localhost:${address.port}/ai/search`;

  try {
    // Test A: Outsider / Non-member gets 403 Forbidden
    console.log("[Step 2] Testing non-member search gets 403 Forbidden...");
    currentUserId = outsiderId;
    const resOutsider = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, query: "calculateTotal" }),
    });

    console.log(`Outsider response status: ${resOutsider.status} (Expected: 403)`);
    if (resOutsider.status !== 403) {
      const errText = await resOutsider.text();
      console.error("Outsider error body:", errText);
      throw new Error(`Expected outsider to get 403, got ${resOutsider.status}`);
    }

    // Test B: Room member gets 200 OK
    console.log("\n[Step 3] Testing room member search gets 200 OK...");
    currentUserId = ownerId;
    const resMember = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, query: "calculateTotal" }),
    });

    console.log(`Member response status: ${resMember.status} (Expected: 200)`);
    if (resMember.status !== 200) {
      throw new Error(`Expected member to get 200, got ${resMember.status}`);
    }

    const memberBody = await resMember.json();
    console.log("Member search response:", memberBody);

    console.log("\n API Service search route and RBAC checks PASSED successfully!");
  } finally {
    server.close();
    killProcessTree(aiProcess);
    await prisma.$disconnect();
  }
}

runApiSearchTest().catch((e) => {
  console.error("API search test failed:", e);
  process.exit(1);
});
