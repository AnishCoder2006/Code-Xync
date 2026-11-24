/**
 * Dev cluster (Week 4 Task 6): two sync nodes + the round-robin LB, one command.
 *   cd services/sync && npm run build && npm run cluster
 * Ports: node1 4001, node2 4002, LB 4000 (override with SYNC_PORT_1/2, LB_PORT).
 * Point the web app at the LB: NEXT_PUBLIC_SYNC_URL=ws://localhost:4000
 */
const { spawn } = require("child_process");
const path = require("path");
const dist = path.resolve(__dirname, "../dist");
const p1 = process.env.SYNC_PORT_1 || "4001";
const p2 = process.env.SYNC_PORT_2 || "4002";
const lb = process.env.LB_PORT || "4000";
const procs = [
  ["node1", "index.js", { SYNC_PORT: p1, NODE_ID: process.env.NODE_ID_1 || `node1:${p1}` }],
  ["node2", "index.js", { SYNC_PORT: p2, NODE_ID: process.env.NODE_ID_2 || `node2:${p2}` }],
  ["lb", "lb-proxy.js", { LB_PORT: lb, SYNC_BACKENDS: `127.0.0.1:${p1},127.0.0.1:${p2}` }],
].map(([name, file, env]) => {
  const child = spawn(process.execPath, [path.join(dist, file)], { env: { ...process.env, ...env }, stdio: "inherit" });
  child.on("exit", (code) => console.log(`[cluster] ${name} exited with ${code}`));
  return child;
});
const stop = () => { procs.forEach((c) => c.kill()); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
