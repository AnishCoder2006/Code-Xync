import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { v4 as uuidv4 } from "uuid";
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { prisma } from "../services/api/src/lib/prisma";
const API_PORT = process.env.PORT || 4000;
const SYNC_PORT = process.env.SYNC_PORT || 4001;

function connectYjsWs(roomId: string, token: string): Promise<{ ws: WebSocket; doc: Y.Doc }> {
  const doc = new Y.Doc();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${SYNC_PORT}?token=${token}&roomId=${roomId}`);

    ws.on("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0); // sync protocol
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

async function runTwoClientAcceptProof() {
  console.log("\n=========================================================================");
  console.log("  Item 5 Proof: Two-Client Accept mutating shared document in real-time  ");
  console.log("=========================================================================\n");

  const testUserA = "user-a-" + uuidv4().slice(0, 8);
  const testUserB = "user-b-" + uuidv4().slice(0, 8);
  const roomId = "room-twoclient-" + uuidv4().slice(0, 8);

  await prisma.user.createMany({
    data: [
      { id: testUserA, email: `a_${testUserA}@codesync.internal`, name: "Client A" },
      { id: testUserB, email: `b_${testUserB}@codesync.internal`, name: "Client B" },
    ],
  });

  await prisma.room.create({
    data: {
      id: roomId,
      title: "Real Two Client Test Room",
      ownerId: testUserA,
      members: {
        create: [
          { userId: testUserA, role: "OWNER" },
          { userId: testUserB, role: "EDITOR" },
        ],
      },
    },
  });

  const clientA = await connectYjsWs(roomId, `test-token-${testUserA}`);
  const clientB = await connectYjsWs(roomId, `test-token-${testUserB}`);

  const initialCode = `def greet(name):\n    return f"Hello, {name}!"\n\ndef add(a, b):\n    return a - b  # BUG: should be a + b\n`;
  clientA.doc.getText("content").insert(0, initialCode);

  // Allow sync to Client B
  await new Promise((r) => setTimeout(r, 600));

  console.log(`1. Initial document synced to Client B: len=${clientB.doc.getText("content").toString().length}`);
  if (!clientB.doc.getText("content").toString().includes("return a - b")) {
    throw new Error("Client B did not receive initial code via WebSocket sync");
  }

  // Create AI interaction for the fix
  const interaction = await prisma.aIInteraction.create({
    data: {
      roomId,
      userId: testUserA,
      prompt: "Fix addition bug in add()",
      baseVersion: "base-v1",
      status: "pending",
    },
  });

  const oldCode = `def add(a, b):\n    return a - b  # BUG: should be a + b`;
  const newCode = `def add(a, b):\n    return a + b`;

  console.log("2. Client A calls PATCH /ai/:id/accept with {oldRangeText, newCode}...");
  const acceptRes = await fetch(`http://localhost:${API_PORT}/ai/${interaction.id}/accept`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer test-token-${testUserA}`,
    },
    body: JSON.stringify({
      oldRangeText: oldCode,
      newCode: newCode,
    }),
  });

  console.log(`   Response status: ${acceptRes.status} (expected 200)`);
  if (acceptRes.status !== 200) {
    const err = await acceptRes.text();
    throw new Error(`Accept failed with status ${acceptRes.status}: ${err}`);
  }

  // Wait for sync broadcast to Client B
  await new Promise((r) => setTimeout(r, 800));

  const docBContent = clientB.doc.getText("content").toString();
  console.log("3. Verifying Client B received updated document in real-time:");
  console.log("   --- Client B Document Content ---");
  console.log(docBContent.trim());
  console.log("   ---------------------------------");

  if (!docBContent.includes("return a + b")) {
    throw new Error("Client B document does NOT contain the accepted fix!");
  }
  if (docBContent.includes("return a - b")) {
    throw new Error("Client B document still contains the old buggy code!");
  }
  console.log("-> PASS: Frontend Accept cleanly mutated shared document and synced to Client B.\n");

  clientA.ws.close();
  clientB.ws.close();
}

async function runReproducingTestLoopProof() {
  console.log("=========================================================================");
  console.log("  Item 6 Proof: Reproducing Test on Original (Fail) and Fixed (Pass)     ");
  console.log("=========================================================================");

  const originalSource = `def multiply_numbers(x: int, y: int) -> int:
    """Return the product of x and y."""
    return x * y

def divide_numbers(x: int, y: int) -> int:
    """Return x divided by y (integer division)."""
    return x - y  # BUG: should be x // y
`;

  const fixedSource = `def multiply_numbers(x: int, y: int) -> int:
    """Return the product of x and y."""
    return x * y

def divide_numbers(x: int, y: int) -> int:
    """Return x divided by y (integer division)."""
    return x // y
`;

  const reproducingTest = `import main
assert main.multiply_numbers(3, 4) == 12
assert main.divide_numbers(10, 2) == 5
print("ALL REPRODUCING TESTS PASSED")
`;

  console.log("\n1. Testing Reproducing Test through Sandbox on ORIGINAL code:");
  const testOrigRes = await fetch(`http://localhost:${API_PORT}/execution/sandbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": "codesync-internal-ai-secret",
    },
    body: JSON.stringify({
      roomId: "repro-test-room",
      language: "python",
      files: {
        "main.py": originalSource,
        "test_main.py": reproducingTest,
      },
      command: ["python3", "test_main.py"],
    }),
  });
  const origData = await testOrigRes.json() as any;
  console.log(`   Original Code Exit Code: ${origData.exitCode} (expected != 0)`);
  console.log(`   Original Code Status:    ${origData.status}`);
  console.log(`   Original Code Output:    ${(origData.stderr || origData.stdout).trim()}`);
  if (origData.exitCode === 0) {
    throw new Error("Expected reproducing test to FAIL on original code, but it passed!");
  }
  console.log("   -> PASS: Original code fails reproducing test as required.");

  console.log("\n2. Testing Reproducing Test through Sandbox on FIXED code:");
  const testFixedRes = await fetch(`http://localhost:${API_PORT}/execution/sandbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": "codesync-internal-ai-secret",
    },
    body: JSON.stringify({
      roomId: "repro-test-room",
      language: "python",
      files: {
        "main.py": fixedSource,
        "test_main.py": reproducingTest,
      },
      command: ["python3", "test_main.py"],
    }),
  });
  const fixedData = await testFixedRes.json() as any;
  console.log(`   Fixed Code Exit Code:    ${fixedData.exitCode} (expected 0)`);
  console.log(`   Fixed Code Status:       ${fixedData.status}`);
  console.log(`   Fixed Code Output:       ${(fixedData.stdout || fixedData.stderr).trim()}`);
  if (fixedData.exitCode !== 0) {
    throw new Error("Expected reproducing test to PASS on fixed code, but it failed!");
  }
  console.log("   -> PASS: Fixed code passes reproducing test cleanly.");
}

async function main() {
  try {
    await runTwoClientAcceptProof();
    await runReproducingTestLoopProof();
    console.log("\n=========================================================================");
    console.log("          ALL ITEMS 5 & 6 PROOFS VERIFIED SUCCESSFULLY                   ");
    console.log("=========================================================================\n");
    process.exit(0);
  } catch (err) {
    console.error("FATAL PROOF ERROR:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
