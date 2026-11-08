import { runInDocker } from "../services/worker/src/sandbox/dockerRunner";
import Redis from "ioredis";

async function main() {
  const redis = new Redis("redis://localhost:6380");

  console.log("[Test 1] Running Python snapshot...");
  const pyRes = await runInDocker("test-snap-py", "test-room", "", "python", redis, {
    files: {
      "calc.py": "def add(a, b):\n    return a + b\n",
      "test_calc.py": "import calc\nassert calc.add(20, 22) == 42\nprint('PYTHON SNAPSHOT SUCCESS')\n",
    },
    command: ["python", "test_calc.py"],
  });
  console.log("Python Result:", pyRes);
  if (pyRes.status !== "passed" || !pyRes.stdout.includes("PYTHON SNAPSHOT SUCCESS")) {
    throw new Error("Python snapshot test failed");
  }

  console.log("\n[Test 2] Running Node snapshot...");
  const nodeRes = await runInDocker("test-snap-node", "test-room", "", "javascript", redis, {
    files: {
      "helper.js": "module.exports = { multiply: (a, b) => a * b };\n",
      "test.js": "const { multiply } = require('./helper');\nif (multiply(6, 7) !== 42) process.exit(1);\nconsole.log('NODE SNAPSHOT SUCCESS');\n",
    },
    command: ["node", "test.js"],
  });
  console.log("Node Result:", nodeRes);
  if (nodeRes.status !== "passed" || !nodeRes.stdout.includes("NODE SNAPSHOT SUCCESS")) {
    throw new Error("Node snapshot test failed");
  }

  console.log("\n[Test 3] Running failing Python test (assert fail)...");
  const failRes = await runInDocker("test-snap-fail", "test-room", "", "python", redis, {
    files: {
      "app.py": "def buggy(): return False\n",
      "test_app.py": "import app\nassert app.buggy() is True, 'Expected buggy() to return True'\n",
    },
    command: ["python", "test_app.py"],
  });
  console.log("Failing Result:", failRes);
  if (failRes.status !== "failed" || failRes.exitCode === 0) {
    throw new Error("Expected failing snapshot to have status 'failed' and non-zero exit code");
  }

  await redis.quit();
  console.log("\nAll snapshot execution tests PASSED!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
