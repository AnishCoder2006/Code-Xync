/**
 * Small round-robin load balancer for sync nodes (Week 4 Task 6, dev/test use).
 *
 *   SYNC_BACKENDS=127.0.0.1:4041,127.0.0.1:4042  LB_PORT=4040  node dist/lb-proxy.js
 *
 * - HTTP requests and WebSocket upgrades are both proxied, round-robin across the
 *   backends currently marked healthy.
 * - Health: every LB_HEALTH_INTERVAL_MS each backend's GET /health is probed. A
 *   connection error on a real request also marks that backend down at once and the
 *   request/upgrade is retried on the next backend, so new connections go to a live
 *   node when an upstream is down.
 * - Every routed WebSocket is logged: "[lb] ws <n> -> <backend> (<nodeId>)" so tests
 *   can see where a client landed. GET /__lb/status returns the backend table.
 *
 * Production uses Nginx (infra/docker/nginx.conf); this exists so tests can kill and
 * restart nodes as plain processes on Windows.
 */
import * as http from "http";
import * as net from "net";

const LB_PORT = Number(process.env.LB_PORT ?? 4000);
const HEALTH_INTERVAL_MS = Number(process.env.LB_HEALTH_INTERVAL_MS ?? 1000);
const backends = (process.env.SYNC_BACKENDS ?? "127.0.0.1:4001")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((hp) => {
    const [host, port] = hp.split(":");
    return { host, port: Number(port), healthy: true, nodeId: "?" as string, routedWs: 0, routedHttp: 0 };
  });
type Backend = (typeof backends)[number];

let rr = 0;
let wsCounter = 0;

/** Backends to try, in round-robin order, healthy ones first. */
function order(): Backend[] {
  const start = rr++ % backends.length;
  const rotated = backends.slice(start).concat(backends.slice(0, start));
  return rotated.filter((b) => b.healthy).concat(rotated.filter((b) => !b.healthy));
}

function markDown(b: Backend, why: string) {
  if (b.healthy) console.log(`[lb] backend ${b.host}:${b.port} (${b.nodeId}) DOWN: ${why}`);
  b.healthy = false;
}

function probe(b: Backend) {
  const req = http.get({ host: b.host, port: b.port, path: "/health", timeout: 800 }, (res) => {
    let s = "";
    res.on("data", (c) => (s += c));
    res.on("end", () => {
      try {
        const j = JSON.parse(s);
        if (!b.healthy) console.log(`[lb] backend ${b.host}:${b.port} (${j.nodeId}) UP`);
        b.nodeId = j.nodeId ?? b.nodeId;
        b.healthy = res.statusCode === 200;
      } catch {
        markDown(b, "bad health body");
      }
    });
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => markDown(b, e.message));
}
setInterval(() => backends.forEach(probe), HEALTH_INTERVAL_MS);
backends.forEach(probe);

const server = http.createServer((req, res) => {
  if (req.url === "/__lb/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(backends));
    return;
  }
  // Buffer the body so the request can be retried on another backend.
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const candidates = order();
    const attempt = (i: number) => {
      const b = candidates[i];
      if (!b) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no healthy sync backend" }));
        return;
      }
      const up = http.request(
        { host: b.host, port: b.port, method: req.method, path: req.url, headers: req.headers },
        (upRes) => {
          b.routedHttp++;
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        }
      );
      up.on("error", (e) => {
        markDown(b, e.message);
        if (!res.headersSent) attempt(i + 1);
        else res.destroy();
      });
      up.end(body);
    };
    attempt(0);
  });
});

server.on("upgrade", (req, clientSocket, head) => {
  const id = ++wsCounter;
  const candidates = order();
  clientSocket.on("error", () => {});
  const attempt = (i: number) => {
    const b = candidates[i];
    if (!b) {
      console.log(`[lb] ws ${id} -> no healthy backend`);
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const up = net.connect(b.port, b.host);
    let connected = false;
    up.once("connect", () => {
      connected = true;
      b.routedWs++;
      console.log(`[lb] ws ${id} -> ${b.host}:${b.port} (${b.nodeId}) ${req.url}`);
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let k = 0; k < req.rawHeaders.length; k += 2) raw += `${req.rawHeaders[k]}: ${req.rawHeaders[k + 1]}\r\n`;
      up.write(raw + "\r\n");
      if (head && head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    up.on("error", (e) => {
      if (!connected) {
        markDown(b, e.message);
        attempt(i + 1);
      } else clientSocket.destroy();
    });
    up.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => up.destroy());
  };
  attempt(0);
});

server.listen(LB_PORT, () => {
  console.log(`[lb] Load balancer listening on :${LB_PORT} -> ${backends.map((b) => `${b.host}:${b.port}`).join(", ")}`);
});
