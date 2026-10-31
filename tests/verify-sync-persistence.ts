process.env.NODE_ENV = "test";

import { spawn, ChildProcess, execSync } from "child_process";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../services/sync/src/lib/prisma";

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

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");
const SYNC_PORT = 4099;

async function runSyncPersistenceTest() {
  console.log("=============================================================");
  console.log("   Verifying Sync Persistence & stream:ai_indexing Events    ");
  console.log("=============================================================\n");

  const userId = "test-user-" + uuidv4().slice(0, 8);
  const roomId = "test-sync-room-" + uuidv4().slice(0, 8);
  const token = `test-token-${userId}`;

  // 1. Seed user and room in PostgreSQL
  console.log(`[Step 1] Creating test room ${roomId} and user ${userId}...`);
  await prisma.user.create({
    data: { id: userId, email: `${userId}@test.com`, name: "Sync Tester" },
  });

  await prisma.room.create({
    data: {
      id: roomId,
      title: "Persistence Test Room",
      ownerId: userId,
      defaultLang: "typescript",
      members: {
        create: [{ userId, role: "OWNER" }],
      },
    },
  });

  // 2. Start Sync service process
  let syncProcess: ChildProcess | null = null;
  const startSyncServer = (): Promise<void> => {
    return new Promise((resolve) => {
      console.log(`[Step 2] Starting sync service on port ${SYNC_PORT}...`);
      syncProcess = spawn("npx", ["tsx", "services/sync/src/index.ts"], {
        env: {
          ...process.env,
          NODE_ENV: "test",
          SYNC_PORT: String(SYNC_PORT),
          REDIS_URL: "redis://localhost:6380",
        },
        stdio: "pipe",
        shell: true,
      });

      syncProcess.stdout?.on("data", (d) => {
        const str = d.toString();
        // console.log(`[sync-stdout] ${str.trim()}`);
        if (str.includes("Sync service running on")) {
          resolve();
        }
      });
      syncProcess.stderr?.on("data", (d) => {
        // console.error(`[sync-stderr] ${d.toString().trim()}`);
      });
    });
  };

  await startSyncServer();

  // Helper to connect and sync Y.Doc
  const connectAndSync = (
    doc: Y.Doc,
    onReady: (ws: WebSocket) => void
  ): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://localhost:${SYNC_PORT}?token=${token}&roomId=${roomId}`;
      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        // Send sync step 1
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
          // MESSAGE_SYNC
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, 0);
          const syncReply = syncProtocol.readSyncMessage(decoder, encoder, doc, null);

          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }

          if (syncReply === syncProtocol.messageYjsSyncStep2 || syncReply === 2) {
            resolve(ws);
            onReady(ws);
          }
        }
      });

      ws.on("error", (err) => reject(err));
    });
  };

  // 3. Connect client 1, write code into doc
  const client1Doc = new Y.Doc();
  console.log("\n[Step 3] Connecting Client 1 and inserting text into Y.Doc...");
  const expectedContent = "function calculateTotal(price, tax) { return price + (price * tax); }";

  await new Promise<void>((resolve) => {
    connectAndSync(client1Doc, (ws) => {
      // Send an update that inserts the text
      client1Doc.on("update", (update) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, update);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encoding.toUint8Array(encoder));
        }
      });

      const ytext = client1Doc.getText("content");
      ytext.insert(0, expectedContent);
      console.log(`Client 1 inserted text: "${expectedContent}"`);

      // Wait a moment for update to be sent over WS
      setTimeout(() => {
        console.log("Client 1 disconnecting (triggering immediate persistence)...");
        ws.close();
        resolve();
      }, 500);
    });
  });

  // 4. Verify PostgreSQL persistence
  console.log("\n[Step 4] Checking PostgreSQL ProjectFile.yjsState...");
  await new Promise((r) => setTimeout(r, 1000));
  const fileRow = await prisma.projectFile.findFirst({ where: { roomId } });
  if (!fileRow || !fileRow.yjsState) {
    throw new Error("ProjectFile row or yjsState not found in PostgreSQL!");
  }
  console.log(`Persisted ProjectFile ID: ${fileRow.id}, path: ${fileRow.path}, yjsState: ${fileRow.yjsState.length} bytes`);

  const testDoc = new Y.Doc();
  Y.applyUpdate(testDoc, new Uint8Array(fileRow.yjsState));
  const restoredText = testDoc.getText("content").toString();
  console.log(`Restored text directly from Postgres yjsState: "${restoredText}"`);
  if (restoredText !== expectedContent) {
    throw new Error(`Text mismatch in Postgres! Expected "${expectedContent}", got "${restoredText}"`);
  }

  // 5. Verify 5s debounced Redis Stream event
  console.log("\n[Step 5] Checking debounced stream:ai_indexing event after 5s idle...");
  console.log("Waiting 6s for idle debouncer to trigger...");
  await new Promise((r) => setTimeout(r, 6000));

  const streamEntries = await redis.xrevrange("stream:ai_indexing", "+", "-", "COUNT", 5);
  console.log(`Found ${streamEntries.length} recent stream:ai_indexing entries.`);

  let matchedEntry: any = null;
  for (const [id, fields] of streamEntries) {
    const entryObj: any = {};
    for (let i = 0; i < fields.length; i += 2) {
      entryObj[fields[i]] = fields[i + 1];
    }
    if (entryObj.roomId === roomId) {
      matchedEntry = { id, ...entryObj };
      break;
    }
  }

  console.log("Matched stream:ai_indexing event:", matchedEntry);
  if (!matchedEntry) {
    throw new Error(`No stream:ai_indexing entry found for roomId ${roomId}`);
  }
  if (matchedEntry.content !== expectedContent) {
    throw new Error(`Stream content mismatch! Expected "${expectedContent}", got "${matchedEntry.content}"`);
  }
  console.log(" stream:ai_indexing event verified successfully!");

  // 6. Restart test: kill sync service, start clean instance, connect Client 2
  console.log("\n[Step 6] Killing sync service to simulate restart...");
  killProcessTree(syncProcess);
  await new Promise((r) => setTimeout(r, 1000));

  console.log("Starting brand new sync service instance...");
  await startSyncServer();

  console.log("Connecting Client 2 with completely empty Y.Doc to newly restarted sync service...");
  const client2Doc = new Y.Doc();
  await new Promise<void>((resolve, reject) => {
    connectAndSync(client2Doc, (ws) => {
      setTimeout(() => {
        const client2Content = client2Doc.getText("content").toString();
        console.log(`Client 2 received content after sync service restart: "${client2Content}"`);
        if (client2Content === expectedContent) {
          console.log(" Client 2 successfully loaded document from Postgres after restart!");
          ws.close();
          resolve();
        } else {
          ws.close();
          reject(new Error(`Restart test failed: expected "${expectedContent}", got "${client2Content}"`));
        }
      }, 500);
    }).catch(reject);
  });

  console.log("\n=============================================================");
  console.log(" All Sync Persistence and stream:ai_indexing tests PASSED!  ");
  console.log("=============================================================");

  killProcessTree(syncProcess);
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

runSyncPersistenceTest().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
