import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";

interface TerminalProps {
  roomId: string;
  jobId: string | null; // null = no active job, panel stays hidden
  onJobEnd?: () => void;
}

/**
 * Streams execution output from Redis Pub/Sub via the Sync WebSocket.
 * The subscription is strictly scoped to the current (roomId, jobId) pair:
 * - Subscribes when jobId becomes non-null
 * - Unsubscribes (and clears the terminal) when jobId goes null or changes
 * This prevents dangling subscriptions from multiple Run clicks.
 */
export function Terminal({ roomId, jobId, onJobEnd }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { getToken } = useAuth();

  // Bootstrap xterm lazily (it uses browser APIs, so must be client-side only)
  useEffect(() => {
    let term: any;
    let fitAddon: any;

    import("@xterm/xterm").then(({ Terminal: XTerm }) => {
      import("@xterm/addon-fit").then(({ FitAddon }) => {
        if (!containerRef.current) return;
        term = new XTerm({ theme: { background: "#1e1e1e" }, fontSize: 13, convertEol: true });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);
        fitAddon.fit();
        termRef.current = term;
        fitRef.current = fitAddon;
      });
    });

    const handleResize = () => fitRef.current?.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term?.dispose();
    };
  }, []);

  // Scope the WS subscription to the active jobId
  useEffect(() => {
    if (!jobId) return;

    const term = termRef.current;
    if (term) {
      term.clear();
      term.writeln(`\x1b[33m▶ Running job ${jobId}…\x1b[0m`);
    }

    // Connect to Sync service; send a subscription intent message
    const syncUrl = (process.env.NEXT_PUBLIC_SYNC_URL || "ws://localhost:4001");
    const token =
      typeof window !== "undefined"
        ? (document.cookie.match(/(?:^|; )__session=([^;]*)/) ?? [])[1] ?? ""
        : "";

    const ws = new WebSocket(
      `${syncUrl}?token=${encodeURIComponent(token)}&roomId=${encodeURIComponent(roomId)}&mode=terminal&jobId=${encodeURIComponent(jobId)}`
    );
    wsRef.current = ws;

    // ── Signal ready rendezvous to API once WS connection is open ──
    ws.onopen = async () => {
      try {
        const api = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
        const authToken = (await getToken()) || token;
        await fetch(`${api}/execution/${jobId}/ready`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
        });
      } catch (err) {
        console.error("[terminal] failed to send ready signal:", err);
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg: { type: string; data?: string; code?: number | null } = JSON.parse(ev.data);
        if (msg.type === "stdout" && msg.data) term?.write(msg.data);
        if (msg.type === "stderr" && msg.data) term?.write(`\x1b[31m${msg.data}\x1b[0m`);
        if (msg.type === "end") {
          const exitColor = msg.code === 0 ? "\x1b[32m" : "\x1b[31m";
          term?.writeln(`\n${exitColor}Process exited with code ${msg.code ?? "?"}\x1b[0m`);
          ws.close();
          onJobEnd?.();
        }
      } catch {
        // ignore non-JSON frames (e.g. Yjs binary frames on a shared connection)
      }
    };

    ws.onerror = () => term?.writeln("\x1b[31m[WS error]\x1b[0m");

    return () => {
      // Unsubscribe when jobId changes or component unmounts — prevents dangling subs
      ws.close();
      wsRef.current = null;
    };
  }, [roomId, jobId, onJobEnd]);

  if (!jobId) return null;

  return (
    <div
      ref={containerRef}
      style={{
        height: "220px",
        background: "#1e1e1e",
        borderRadius: "4px",
        overflow: "hidden",
        marginTop: "8px",
      }}
    />
  );
}

export default Terminal;
