/**
 * Playwright global setup:
 * - Ensures Postgres has the schema
 * - Seeds test users and rooms
 * - Starts two sync nodes + LB proxy
 * - Stores process refs and ports for teardown
 */
import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";

const SYNC_DIST = path.resolve(__dirname, "../../services/sync/dist/index.js");
const LB_DIST = path.resolve(__dirname, "../../services/sync/dist/lb-proxy.js");

export const PORT_NODE1 = 4041;
export const PORT_NODE2 = 4042;
export const LB_PORT = 4040;
export const INTERNAL_SECRET = "codesync-internal-ai-secret";

// Room/user IDs reused across tests
export const TEST_ROOM = "pw-test-room";
export const USER_A = "pw-user-a";
export const USER_B = "pw-user-b";
export const USER_C = "pw-user-c";

function killProc(proc: ChildProcess | null) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {}
}

function startNode(port: number, nodeId: string): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const proc = spawn("node", [SYNC_DIST], {
      env: {
        ...process.env,
        SYNC_PORT: String(port),
        PORT: String(port),
        NODE_ID: nodeId,
        NODE_ENV: "test",
        INTERNAL_API_SECRET: INTERNAL_SECRET,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => {
      if (d.toString().includes(`:${port}`)) resolve(proc);
    });
    proc.stderr?.on("data", () => {});
    setTimeout(() => resolve(proc), 4000);
  });
}

function startLB(): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const proc = spawn("node", [LB_DIST], {
      env: {
        ...process.env,
        LB_PORT: String(LB_PORT),
        SYNC_BACKENDS: `127.0.0.1:${PORT_NODE1},127.0.0.1:${PORT_NODE2}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => {
      if (d.toString().includes("Load balancer")) resolve(proc);
    });
    proc.stderr?.on("data", () => {});
    setTimeout(() => resolve(proc), 3000);
  });
}

// Store in global so teardown can kill them
declare global {
  // eslint-disable-next-line no-var
  var __PW_PROCS: ChildProcess[];
}

export default async function globalSetup() {
  // 1. Seed DB
  const { prisma } = require("../../services/api/src/lib/prisma");

  try {
    // Upsert users
    for (const uid of [USER_A, USER_B, USER_C]) {
      await prisma.user.upsert({
        where: { id: uid },
        create: { id: uid, email: `${uid}@test.com`, name: uid },
        update: {},
      });
    }

    // Upsert room
    const existing = await prisma.room.findUnique({ where: { id: TEST_ROOM } });
    if (!existing) {
      await prisma.room.create({
        data: {
          id: TEST_ROOM,
          title: "Playwright Test Room",
          ownerId: USER_A,
          members: {
            create: [
              { userId: USER_A, role: "OWNER" },
              { userId: USER_B, role: "EDITOR" },
              { userId: USER_C, role: "EDITOR" },
            ],
          },
        },
      });
    }

    // Clear old Yjs state so tests start fresh
    await prisma.projectFile.deleteMany({ where: { roomId: TEST_ROOM } });
  } finally {
  }

  // 2. Start sync nodes + LB
  console.log("[PW Setup] Starting sync nodes and LB...");
  const proc1 = await startNode(PORT_NODE1, "pw-node-01");
  const proc2 = await startNode(PORT_NODE2, "pw-node-02");
  const lb = await startLB();
  globalThis.__PW_PROCS = [proc1, proc2, lb];

  // Wait for nodes to be ready
  await new Promise((r) => setTimeout(r, 2000));
  console.log("[PW Setup] Infrastructure ready.");
}

// Playwright calls this file's default export for setup.
// For teardown, we use a separate file or process.on.
process.on("exit", () => {
  if (globalThis.__PW_PROCS) {
    for (const p of globalThis.__PW_PROCS) killProc(p);
  }
});

