// Small typed client for the CodeSync API. Every call sends the bearer token.
import { languageInfo } from "./languages";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const SYNC_URL = process.env.NEXT_PUBLIC_SYNC_URL || "ws://localhost:4001";

export type GetToken = () => Promise<string | null>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: any = null,
    public retryAfter: number | null = null
  ) {
    super(message);
  }
}

export async function authHeaders(getToken: GetToken): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api<T = any>(
  getToken: GetToken,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: {
        ...(await authHeaders(getToken)),
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const header = Number(res.headers.get("retry-after"));
    const retryAfter = Number.isFinite(header) && header > 0 ? header : typeof data?.retryAfter === "number" ? data.retryAfter : null;
    throw new ApiError(res.status, data?.error || res.statusText || `HTTP ${res.status}`, data, retryAfter);
  }
  return data as T;
}

/** A sentence a person can act on, for any API failure. */
export function describeError(err: unknown, context?: "run" | "ai"): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  const msg = typeof err.data?.error === "string" ? err.data.error : "";
  switch (err.status) {
    case 0:
      return "Can't reach the server. Check your connection and try again.";
    case 401:
      return msg && msg !== "Unauthorized" ? msg : "Your session has expired. Sign in again.";
    case 403:
      return msg.replace(/^Forbidden:\s*/, "") || "You don't have access to this.";
    case 404:
      return msg || "Not found.";
    case 413:
      return "The file is too large (limit 100 KB).";
    case 429:
      if (context === "ai" && /quota/i.test(msg)) return "You've used today's AI fix allowance. It resets within 24 hours.";
      return err.retryAfter
        ? `Rate limit reached. Try again in ${err.retryAfter} s.`
        : "Rate limit reached. Try again in a minute.";
    case 503:
      return context === "run"
        ? "The sandbox is busy right now. Retry in a few seconds."
        : "The service is busy right now. Retry in a few seconds.";
    default:
      return msg || `Request failed (HTTP ${err.status}).`;
  }
}

// ── API shapes ─────────────────────────────────────────────────────────────
export type Role = "OWNER" | "EDITOR" | "VIEWER";
/** A language id from lib/languages.ts. */
export type Language = string;

export type RoomSummary = {
  id: string;
  title: string;
  language: Language;
  isPrivate: boolean;
  hasPasscode: boolean;
  ownerId: string;
  role: Role;
  memberCount: number;
  createdAt: string;
  lastUpdatedAt: string;
};

export type RoomDetail = {
  id: string;
  title: string;
  language: Language;
  isPrivate: boolean;
  hasPasscode: boolean;
  ownerId: string;
  createdAt: string;
  myRole: Role | null;
  members: { userId: string; name: string | null; role: Role; joinedAt: string }[];
};

export const fileNameFor = (language: string) => languageInfo(language).file;
export const languageLabel = (language: string) => languageInfo(language).label;
export const roleLabel = (role: Role | null | undefined) =>
  role === "OWNER" ? "Owner" : role === "EDITOR" ? "Editor" : role === "VIEWER" ? "Viewer" : "";

export type SearchHit = {
  path: string;
  start_line: number;
  end_line: number;
  ast_type: string;
  function_name: string;
  score: number;
  text: string;
};

type Who = { id: string; name: string | null };
export type RunRecord = { jobId: string; status: string; runTimeMs: number | null; createdAt: string; user?: Who; preview?: string; room?: { id: string; title: string; language: string } };
export type FixRecord = { id: string; prompt: string; status: string; attempts: number | null; costUsd: number | null; createdAt: string; user?: Who; room?: { id: string; title: string; language: string } };
export type RoomHistory = { runs: RunRecord[]; aiFixes: FixRecord[] };
export type Activity = { summary: { runs7d: number; aiFixes7d: number; accepted7d: number }; runs: RunRecord[]; aiFixes: FixRecord[] };

export type SyncNode = {
  nodeId: string; ok: boolean; latencyMs: number; error?: string;
  rooms: number | null; clients: number | null; uptimeMs: number | null; redis: string | null;
  routedWs: number | null; published: number | null; received: number | null;
};
export type SystemStatus = {
  checkedAt: string;
  api: { ok: boolean; uptimeMs: number; nodeEnv: string };
  redis: { ok: boolean; latencyMs: number; error?: string };
  queue: { ok: boolean; error?: string; waiting?: number; active?: number; delayed?: number; completed?: number; failed?: number; maxQueueLength: number; ratePerMinute: number };
  sync: { loadBalanced: boolean; nodes: SyncNode[] };
  ai: { ok: boolean; latencyMs: number; error?: string; provider: string | null };
};

/** Human labels for run / AI statuses (shared by history and activity). */
export const RUN_STATUS: Record<string, { label: string; tone: "success" | "destructive" | "warning" | "secondary" }> = {
  passed: { label: "Exit 0", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
  timeout: { label: "Timed out", tone: "warning" },
  killed: { label: "Killed", tone: "destructive" },
  truncated: { label: "Output capped", tone: "warning" },
  running: { label: "Running", tone: "secondary" },
  queued: { label: "Queued", tone: "secondary" },
};
export const FIX_STATUS: Record<string, { label: string; tone: "success" | "destructive" | "warning" | "secondary" | "accent" }> = {
  accepted: { label: "Accepted", tone: "success" },
  verified: { label: "Verified, not applied", tone: "accent" },
  unverified_no_test: { label: "Ran cleanly, not applied", tone: "accent" },
  rejected: { label: "Rejected", tone: "secondary" },
  stale: { label: "Stale (file changed)", tone: "warning" },
  exhausted: { label: "No working fix", tone: "destructive" },
  apply_error: { label: "Couldn't apply", tone: "destructive" },
  failed: { label: "Failed", tone: "destructive" },
  error: { label: "Error", tone: "destructive" },
  pending: { label: "In progress", tone: "secondary" },
};
