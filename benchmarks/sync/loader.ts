/**
 * B1 load-generator child process. Hosts a share of the benchmark's Yjs clients.
 * Protocol with the parent (benchmarks/sync/sync-latency.ts) over IPC:
 *   parent -> {type:"connect", url, clients:[{idx, userId, roomId}]}
 *   child  -> {type:"connected", n}
 *   parent -> {type:"go", startAt, edits, intervalMs}
 *   child  -> {type:"done", samples:[[latencyMs, senderIdx, receiverIdx], ...], sent}
 *
 * Each edit appends a marker ⟦sender.seq.tSend⟧ to the room's Y.Text. tSend is
 * performance.timeOrigin + performance.now() (wall-clock based, sub-ms; the parent and
 * every loader run on the same machine). Receivers parse markers from remote Y.Text
 * deltas and record now - tSend.
 */
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { performance } from "perf_hooks";

const nowMs = () => performance.timeOrigin + performance.now();
const MARKER = /⟦(\d+)\.(\d+)\.(\d+\.\d+)⟧/g;

interface Client {
  idx: number;
  ws: WebSocket;
  doc: Y.Doc;
  text: Y.Text;
}

const samples: Array<[number, number, number]> = [];
let recording = false;
let sent = 0;

function connect(url: string, c: { idx: number; userId: string; roomId: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const ws = new WebSocket(`${url}/${c.roomId}?token=test-token-${c.userId}&roomId=${c.roomId}`);
    const to = setTimeout(() => reject(new Error(`connect timeout ${c.userId}`)), 20000);
    ws.on("open", () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, doc);
      ws.send(encoding.toUint8Array(e));
    });
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, u);
      ws.send(encoding.toUint8Array(e));
    });
    text.observe((ev, tr) => {
      if (tr.local || !recording) return;
      const t = nowMs();
      for (const d of ev.delta) {
        if (typeof d.insert !== "string") continue;
        for (const m of d.insert.matchAll(MARKER)) samples.push([t - Number(m[3]), Number(m[1]), c.idx]);
      }
    });
    ws.on("message", (raw: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(raw));
      if (decoding.readVarUint(dec) !== 0) return; // awareness etc. ignored
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      const r = syncProtocol.readSyncMessage(dec, e, doc, ws);
      if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
      if (r === syncProtocol.messageYjsSyncStep2) {
        clearTimeout(to);
        resolve({ idx: c.idx, ws, doc, text });
      }
    });
    ws.on("error", (err) => {
      clearTimeout(to);
      reject(err);
    });
  });
}

let clients: Client[] = [];

process.on("message", async (msg: any) => {
  if (msg.type === "connect") {
    clients = [];
    // Connect in small batches so the connection storm itself is not the benchmark.
    for (let i = 0; i < msg.clients.length; i += 10) {
      clients.push(...(await Promise.all(msg.clients.slice(i, i + 10).map((c: any) => connect(msg.url, c)))));
    }
    process.send!({ type: "connected", n: clients.length });
  } else if (msg.type === "go") {
    samples.length = 0;
    sent = 0;
    recording = true;
    const { startAt, edits, intervalMs } = msg;
    await Promise.all(
      clients.map(
        (c) =>
          new Promise<void>((resolve) => {
            const offset = Math.random() * intervalMs;
            let seq = 0;
            const tick = () => {
              const tSend = nowMs();
              c.text.insert(c.text.length, `⟦${c.idx}.${seq}.${tSend.toFixed(3)}⟧`);
              sent++;
              seq++;
              if (seq < edits) setTimeout(tick, startAt + offset + seq * intervalMs - Date.now());
              else resolve();
            };
            setTimeout(tick, Math.max(0, startAt + offset - Date.now()));
          })
      )
    );
    process.send!({ type: "sent" });
  } else if (msg.type === "collect") {
    recording = false;
    process.send!({ type: "done", samples, sent });
  } else if (msg.type === "close") {
    clients.forEach((c) => c.ws.close());
    setTimeout(() => process.exit(0), 300);
  }
});
