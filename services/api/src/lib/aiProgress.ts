// AI fix progress events over Redis (plan step 1.2).
//
// Keys for one fix run, all expiring after PROGRESS_TTL_S:
//   ai:progress:<id>          pub/sub channel, one JSON message per event
//   ai:progress:<id>:log      list of every event, for replay to late subscribers
//   ai:progress:<id>:seq      counter; each event gets the next seq (1, 2, ...)
//   ai:progress:<id>:done     set once a terminal event (done | failed) is published
//   ai:progress:<id>:owner    {"roomId","userId"} bound by POST /ai/fix
//
// Event: {"seq": n, "step": "context"|"generating"|"applying"|"testing"|"retrying"|"done"|"failed",
//         "attempt"?: n, "status"?: string, "message"?: string, "ts": epoch ms, ...}
// The AI service (services/ai/app/agent/progress.py) publishes with the same Lua script,
// so seq order, list order and publish order are identical.

import Redis from "ioredis";
import { logger } from "../middleware/logger";

export const PROGRESS_TTL_S = 900;

export type ProgressEvent = {
  seq: number;
  step: string;
  attempt?: number;
  status?: string;
  message?: string;
  ts: number;
  [k: string]: unknown;
};

// KEYS: seq, log, channel, done   ARGV: event JSON without seq, ttl, onlyIfOpen, isTerminal
export const PUBLISH_SCRIPT = `
if ARGV[3] == '1' and redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
local seq = redis.call('INCR', KEYS[1])
local ev = '{"seq":' .. seq .. ',' .. string.sub(ARGV[1], 2)
redis.call('RPUSH', KEYS[2], ev)
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
if ARGV[4] == '1' then redis.call('SET', KEYS[4], '1', 'EX', ARGV[2]) end
redis.call('PUBLISH', KEYS[3], ev)
return seq
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidProgressId = (id: unknown): id is string => typeof id === "string" && UUID_RE.test(id);
export const isTerminal = (e: { step?: string }) => e.step === "done" || e.step === "failed";

const keys = (id: string) => ({
  channel: `ai:progress:${id}`,
  log: `ai:progress:${id}:log`,
  seq: `ai:progress:${id}:seq`,
  done: `ai:progress:${id}:done`,
  owner: `ai:progress:${id}:owner`,
});

const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
let cmd: Redis | null = null;
let sub: Redis | null = null;
const listeners = new Map<string, Set<(raw: string) => void>>();
const subscribed = new Map<string, Promise<unknown>>(); // channel -> SUBSCRIBE in flight / done

function commandClient(): Redis {
  if (!cmd) cmd = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  return cmd;
}

function subscriberClient(): Redis {
  if (!sub) {
    sub = new Redis(redisUrl);
    sub.on("message", (channel: string, message: string) => {
      listeners.get(channel)?.forEach((fn) => fn(message));
    });
    sub.on("error", (err) => logger.warn({ err }, "AI progress subscriber error"));
  }
  return sub;
}

/** Bind a progressId to (room, user). False if it is already bound to someone else. */
export async function bindProgressId(id: string, roomId: string, userId: string): Promise<boolean> {
  const k = keys(id);
  const value = JSON.stringify({ roomId, userId });
  const set = await commandClient().set(k.owner, value, "EX", PROGRESS_TTL_S, "NX");
  if (set === "OK") return true;
  return (await commandClient().get(k.owner)) === value;
}

export async function getProgressOwner(id: string): Promise<{ roomId: string; userId: string } | null> {
  const raw = await commandClient().get(keys(id).owner);
  return raw ? JSON.parse(raw) : null;
}

/** Publish one event. With onlyIfOpen, nothing is published after a terminal event. Returns seq or 0. */
export async function publishProgress(
  id: string,
  event: { step: string; [k: string]: unknown },
  opts: { onlyIfOpen?: boolean } = {}
): Promise<number> {
  const k = keys(id);
  const body = JSON.stringify({ ...event, ts: Date.now() });
  const seq = await commandClient().eval(
    PUBLISH_SCRIPT, 4, k.seq, k.log, k.channel, k.done,
    body, String(PROGRESS_TTL_S), opts.onlyIfOpen ? "1" : "0", isTerminal(event) ? "1" : "0"
  );
  return Number(seq);
}

/**
 * Deliver every event of a run, in seq order, exactly once: subscribe first, then replay
 * the log, then forward live events with a higher seq. Live events that arrive while the
 * replay is running are buffered. Resolves once the subscription is active.
 */
export async function subscribeProgress(
  id: string,
  onEvent: (e: ProgressEvent) => void
): Promise<() => Promise<void>> {
  const k = keys(id);
  let lastSeq = 0;
  let replaying = true;
  const buffered: ProgressEvent[] = [];

  const deliver = (e: ProgressEvent) => {
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    onEvent(e);
  };
  const onRaw = (raw: string) => {
    let e: ProgressEvent;
    try { e = JSON.parse(raw); } catch { return; }
    if (replaying) buffered.push(e);
    else deliver(e);
  };

  let set = listeners.get(k.channel);
  if (!set) listeners.set(k.channel, (set = new Set()));
  set.add(onRaw);
  if (!subscribed.has(k.channel)) subscribed.set(k.channel, subscriberClient().subscribe(k.channel));
  await subscribed.get(k.channel);

  const history = await commandClient().lrange(k.log, 0, -1);
  for (const raw of history) {
    try { deliver(JSON.parse(raw)); } catch { /* skip malformed */ }
  }
  replaying = false;
  buffered.sort((a, b) => a.seq - b.seq).forEach(deliver);

  return async () => {
    const s = listeners.get(k.channel);
    if (!s) return;
    s.delete(onRaw);
    if (s.size === 0) {
      listeners.delete(k.channel);
      subscribed.delete(k.channel);
      await subscriberClient().unsubscribe(k.channel);
    }
  };
}

/** For tests and graceful shutdown. */
export async function closeProgressClients(): Promise<void> {
  await Promise.all([cmd?.quit(), sub?.quit()].filter(Boolean) as Promise<unknown>[]);
  cmd = null;
  sub = null;
  listeners.clear();
  subscribed.clear();
}
