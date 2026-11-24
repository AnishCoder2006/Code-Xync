import { API_URL, authHeaders, type GetToken } from "./api";

export type ProgressEvent = {
  seq: number;
  step: "context" | "generating" | "applying" | "testing" | "retrying" | "done" | "failed" | string;
  attempt?: number;
  retry?: number;
  reason?: string;
  status?: string;
  message?: string;
  llm_calls?: number;
  total_cost_usd?: number;
};

/**
 * Subscribe to GET /ai/progress/:id (server-sent events) with fetch, because
 * EventSource cannot send an Authorization header. `ready` resolves once the server
 * is subscribed (or the stream failed); `done` when the stream ends.
 */
export function openProgressStream(opts: {
  progressId: string;
  roomId: string;
  getToken: GetToken;
  onEvent: (e: ProgressEvent) => void;
  signal: AbortSignal;
}) {
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));
  const done = (async () => {
    try {
      const res = await fetch(
        `${API_URL}/ai/progress/${opts.progressId}?roomId=${encodeURIComponent(opts.roomId)}`,
        { headers: await authHeaders(opts.getToken), signal: opts.signal }
      );
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (type === "ready") markReady();
          else if (type === "progress" && data) {
            try { opts.onEvent(JSON.parse(data)); } catch { /* ignore malformed frame */ }
          }
        }
      }
    } catch {
      // aborted or network error: progress is best effort, the POST result is authoritative
    } finally {
      markReady();
    }
  })();
  return { ready, done };
}
