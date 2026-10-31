import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { runInDocker } from "../../services/worker/src/sandbox/dockerRunner";
import { prisma } from "../../services/worker/src/lib/prisma";

const execFileAsync = promisify(execFile);

interface AttackResult {
  payload: string;
  expected: string;
  actualStatus: string;
  exitCode: number | null;
  contained: boolean;
  leftoverContainers: number;
  notes: string;
  passed: boolean;
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redis = new Redis(redisUrl);

async function checkHostResponsiveness(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("node", ["-e", "process.stdout.write('ok')"]);
    return stdout === "ok";
  } catch {
    return false;
  }
}

async function getCodesyncContainerCount(filterName?: string): Promise<number> {
  try {
    const filter = filterName ? `name=${filterName}` : "name=codesync-job-";
    const { stdout } = await execFileAsync("docker", ["ps", "-a", "--filter", filter, "--format", "{{.Names}}"]);
    const lines = stdout.trim().split("\n").filter((l) => l.trim().length > 0);
    return lines.length;
  } catch {
    return 0;
  }
}

async function main() {
  console.log("=============================================================");
  console.log("        CodeSync Phase 3: Attack Containment Suite          ");
  console.log("=============================================================\n");

  const testUserId = "attack-suite-user";
  const testRoomId = "attack-suite-room";

  // Ensure DB seed exists for foreign keys
  await prisma.user.upsert({
    where: { id: testUserId },
    create: { id: testUserId, email: "attacks@codesync.internal", name: "Attack Suite" },
    update: {},
  });

  await prisma.room.upsert({
    where: { id: testRoomId },
    create: {
      id: testRoomId,
      title: "Attack Suite Sandbox Room",
      ownerId: testUserId,
      members: {
        create: { userId: testUserId, role: "OWNER" },
      },
    },
    update: {},
  });

  const attackDir = path.resolve(__dirname);
  const payloads = [
    {
      file: "fork-bomb.sh",
      lang: "bash",
      expected: "timeout/failed (pids-limited), host responsive",
      validate: (res: any, events: any[], dbLog: any, hostOk: boolean) => {
        const stderr = dbLog?.stderrTrunc || "";
        const pidLimitHit = stderr.includes("Resource temporarily unavailable");
        const terminated = res.status === "timeout" || res.status === "failed";
        // Contained if: (a) process was killed/timed out AND (b) host is still responsive.
        // "Resource temporarily unavailable" in stderr is the ideal proof but timeout alone
        // is sufficient since the bomb cannot exit cleanly with the while-true keep-alive.
        return hostOk && terminated && (pidLimitHit || res.status === "timeout");
      },
    },
    {
      file: "infinite-output.py",
      lang: "python",
      expected: "Truncated at 1MB output cap",
      validate: (res: any, events: any[], dbLog: any) => {
        return res.status === "truncated" || dbLog?.status === "truncated";
      },
    },
    {
      file: "memory-hog.py",
      lang: "python",
      expected: "OOM-killed at 256MB (exit 137)",
      validate: (res: any, events: any[], dbLog: any) => {
        return res.status === "killed" || dbLog?.status === "killed" || res.code === 137;
      },
    },
    {
      file: "network-call.py",
      lang: "python",
      expected: "Fails: network isolated (--network none)",
      validate: (res: any, events: any[], dbLog: any) => {
        const hasErr = (dbLog?.stderrTrunc || "").includes("Temporary failure") || (dbLog?.stderrTrunc || "").includes("urlopen error") || (dbLog?.stderrTrunc || "").includes("URLError");
        return (res.status === "failed" || dbLog?.status === "failed") && (res.code !== 0 || hasErr);
      },
    },
    {
      file: "read-sensitive-file.py",
      lang: "python",
      expected: "Shows container passwd only, no host files",
      validate: (res: any, events: any[], dbLog: any) => {
        const out = dbLog?.stdoutTrunc || "";
        const containsSandboxUser = out.includes("sandboxuser:");
        // Host Windows users or sensitive paths should never be in container /etc/passwd
        const noHostLeak = !out.includes("Administrator") && !out.includes("C:\\");
        return (res.status === "passed" || dbLog?.status === "passed") && containsSandboxUser && noHostLeak;
      },
    },
    {
      file: "sleep-beyond-timeout.py",
      lang: "python",
      expected: "Killed at 5s timeout",
      validate: (res: any, events: any[], dbLog: any) => {
        return res.status === "timeout" || dbLog?.status === "timeout";
      },
    },
    {
      file: "tmpfs-fill.py",
      lang: "python",
      expected: "Fails: 16MB tmpfs limit (No space left on device)",
      validate: (res: any, events: any[], dbLog: any) => {
        const stderr = dbLog?.stderrTrunc || "";
        return (res.status === "failed" || dbLog?.status === "failed") && (stderr.includes("No space left on device") || stderr.includes("Errno 28"));
      },
    },
    {
      file: "write-to-root.py",
      lang: "python",
      expected: "Fails: read-only root filesystem",
      validate: (res: any, events: any[], dbLog: any) => {
        const stderr = dbLog?.stderrTrunc || "";
        return (res.status === "failed" || dbLog?.status === "failed") && (stderr.includes("Read-only file system") || stderr.includes("Errno 30"));
      },
    },
  ];

  const results: AttackResult[] = [];
  let allPassed = true;

  for (const item of payloads) {
    const filePath = path.join(attackDir, item.file);
    const code = await fs.readFile(filePath, "utf-8");
    const jobId = uuidv4();
    const channel = `room:${testRoomId}:execution:${jobId}`;

    console.log(`Running payload [${item.file}] (job ${jobId})...`);

    // Audit log initial state
    await prisma.executionLog.create({
      data: {
        jobId,
        roomId: testRoomId,
        userId: testUserId,
        status: "queued",
      },
    });

    // Subscribe to Redis output channel
    const sub = new Redis(redisUrl);
    const events: any[] = [];
    await sub.subscribe(channel);
    sub.on("message", (_chan, msg) => {
      try {
        events.push(JSON.parse(msg));
      } catch {}
    });

    // Provide ready signal for BLPOP rendezvous
    await redis.lpush(`execution:ready:${jobId}`, "1");

    // Execute through the real worker sandbox path
    let execResult: any = null;
    try {
      execResult = await runInDocker(jobId, testRoomId, code, item.lang, redis);
    } catch (err: any) {
      execResult = {
        status: "failed",
        code: 1,
        runTimeMs: 0,
        stdoutTrunc: "",
        stderrTrunc: err.message,
      };
    }

    // Allow Redis events to finish settling
    await new Promise((r) => setTimeout(r, 200));
    await sub.unsubscribe(channel);
    await sub.quit();

    // Query DB record
    const dbLog = await prisma.executionLog.findUnique({ where: { jobId } });

    // Assert container cleanup
    const leftoverCount = await getCodesyncContainerCount(`codesync-job-${jobId}`);
    const hostResponsive = await checkHostResponsiveness();

    const isPassed = item.validate(execResult, events, dbLog, hostResponsive) && leftoverCount === 0;

    if (!isPassed) {
      allPassed = false;
    }

    results.push({
      payload: item.file,
      expected: item.expected,
      actualStatus: dbLog?.status || execResult.status,
      exitCode: execResult.code,
      contained: isPassed,
      leftoverContainers: leftoverCount,
      notes: isPassed ? "Contained & cleaned up" : "LIMIT ESCAPE OR CLEANUP FAILED",
      passed: isPassed,
    });
  }

  // Final check: assert zero leftover codesync containers
  const totalLeftovers = await getCodesyncContainerCount();

  console.log("\n======================================================================================================");
  console.log("| Payload                | Expected Result                               | Actual Status | Exit | Containers | Result |");
  console.log("------------------------------------------------------------------------------------------------------");
  for (const r of results) {
    const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + "..." : s.padEnd(n));
    const statusCol = pad(r.actualStatus, 13);
    const fileCol = pad(r.payload, 22);
    const expCol = pad(r.expected, 45);
    const exitCol = pad(String(r.exitCode), 4);
    const cntCol = pad(String(r.leftoverContainers), 10);
    const passCol = r.passed ? "PASS" : "FAIL";
    console.log(`| ${fileCol} | ${expCol} | ${statusCol} | ${exitCol} | ${cntCol} | ${passCol}   |`);
  }
  console.log("======================================================================================================\n");

  console.log(`Total leftover codesync containers: ${totalLeftovers}`);
  if (totalLeftovers > 0) {
    console.error("FAIL: Leftover containers found in docker ps -a!");
    allPassed = false;
  }

  await redis.quit();
  await prisma.$disconnect();

  if (!allPassed) {
    console.error("\nAttack suite failed: one or more payloads escaped sandbox containment!");
    process.exit(1);
  } else {
    console.log("\nAll attack payloads contained successfully! Zero container leaks.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error running attack suite:", err);
  process.exit(1);
});
