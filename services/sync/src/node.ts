/**
 * Node identity (Week 4 Task 1).
 *
 * NODE_ID defaults to "<hostname>:<port>" so two instances on one machine are
 * still distinguishable. Every log line from this service goes through log()/logErr()
 * so the nodeId is present on connection and join lines.
 */
import * as os from "os";

export const PORT = Number(process.env.SYNC_PORT ?? process.env.PORT ?? 4001);
export const NODE_ID = process.env.NODE_ID || `${os.hostname()}:${PORT}`;

const tag = `[sync:${NODE_ID}]`;

export const log = (...args: unknown[]) => console.log(tag, ...args);
export const logErr = (...args: unknown[]) => console.error(tag, ...args);
