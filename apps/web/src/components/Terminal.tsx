import { useEffect, useRef } from "react";
import { API_URL, SYNC_URL, authHeaders, type GetToken } from "../lib/api";

export type RunEnd = { status: string; code: number | null };

interface TerminalProps {
  roomId: string;
  /** Active job; output for it streams in. null = idle (last output stays readable). */
  jobId: string | null;
  getToken: GetToken;
  syncUrl?: string;
  theme?: "light" | "dark";
  onEnd?: (end: RunEnd) => void;
}

const THEMES = {
  // Match the card surface of the theme (globals.css --card).
  dark: { background: "#11191c", foreground: "#d5e0df", cursor: "#11191c", selectionBackground: "#1f4743" },
  light: { background: "#fdfcfa", foreground: "#1f2a2e", cursor: "#fdfcfa", selectionBackground: "#c9ece6" },
};

/**
 * Streams one execution job's output (Redis pub/sub relayed by the sync service, terminal
 * mode). Subscribes when jobId changes, tells the API it is listening (/ready rendezvous,
 * so no early output is lost), and closes on the job's "end" message.
 */
export function Terminal({ roomId, jobId, getToken, syncUrl, theme = "dark", onEnd }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const queueRef = useRef<string[]>([]); // writes before xterm finished loading
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  const write = (s: string) => {
    if (termRef.current) termRef.current.write(s);
    else queueRef.current.push(s);
  };

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !containerRef.current) return;
      const term = new XTerm({
        theme: THEMES[theme],
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        convertEol: true,
        disableStdin: true,
        cursorBlink: false,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      try { fit.fit(); } catch {}
      termRef.current = term;
      fitRef.current = fit;
      queueRef.current.splice(0).forEach((s) => term.write(s));
      ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
      ro.observe(containerRef.current);
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  useEffect(() => {
    if (!jobId) return;
    termRef.current?.clear();
    termRef.current?.reset();
    queueRef.current = [];
    write(`\x1b[2m$ run · job ${jobId.slice(0, 8)}\x1b[0m\r\n`);

    let ended = false;
    let ws: WebSocket | null = null;
    let cancelled = false;
    const finish = (end: RunEnd) => {
      if (ended) return;
      ended = true;
      ws?.close();
      onEndRef.current?.(end);
    };

    (async () => {
      const token = (await getToken().catch(() => null)) ?? "";
      if (cancelled) return;
      const base = syncUrl || SYNC_URL;
      ws = new WebSocket(
        `${base}?token=${encodeURIComponent(token)}&roomId=${encodeURIComponent(roomId)}&mode=terminal&jobId=${encodeURIComponent(jobId)}`
      );
      ws.onopen = async () => {
        try {
          await fetch(`${API_URL}/execution/${encodeURIComponent(jobId)}/ready`, {
            method: "POST",
            headers: await authHeaders(getToken),
          });
        } catch {
          // The worker starts anyway after a short wait; output may then begin mid-stream.
        }
      };
      ws.onmessage = (ev) => {
        let msg: { type: string; data?: string; code?: number | null; status?: string };
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "stdout" && msg.data) write(msg.data);
        else if (msg.type === "stderr" && msg.data) write(`\x1b[31m${msg.data}\x1b[0m`);
        else if (msg.type === "end") {
          const ok = msg.code === 0;
          write(`\r\n\x1b[${ok ? "32" : "31"}m● exited with code ${msg.code ?? "?"}${msg.status && !ok ? ` (${msg.status})` : ""}\x1b[0m\r\n`);
          finish({ status: msg.status ?? (ok ? "passed" : "failed"), code: msg.code ?? null });
        }
      };
      ws.onerror = () => write("\r\n\x1b[31mLost the connection to the output stream.\x1b[0m\r\n");
      ws.onclose = () => {
        if (!ended && !cancelled) finish({ status: "disconnected", code: null });
      };
    })();

    return () => {
      cancelled = true;
      ended = true;
      ws?.close();
    };
  }, [roomId, jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden pl-3 pt-2" data-testid="terminal" />;
}

export default Terminal;
