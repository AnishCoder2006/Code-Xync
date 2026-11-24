/**
 * Test-only editor page body (Week 4 Task 7). Mounted by src/pages/e2e/editor.tsx
 * ONLY in builds made with NEXT_PUBLIC_E2E=1; production builds never compile it.
 *
 *   /e2e/editor?room=<roomId>&uid=<userId>[&syncUrl=ws://host:port]
 *
 * Uses the real Editor component with token "test-token-<uid>" (the sync service
 * accepts that only when it runs with NODE_ENV=test). Connection status is exposed on
 * window.__e2e and in the DOM so Playwright can assert reconnects without reloads.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/router";
import type { WebsocketProvider } from "y-websocket";
import Editor from "../components/Editor";

declare global {
  interface Window {
    __e2e?: {
      pageLoadId: string;
      status: string;
      synced: boolean;
      connects: number;
      disconnects: number;
    };
  }
}

export default function E2EEditorPage() {
  const router = useRouter();
  const [status, setStatus] = useState("init");
  const [connects, setConnects] = useState(0);

  useEffect(() => {
    if (!window.__e2e) {
      window.__e2e = {
        pageLoadId: Math.random().toString(36).slice(2),
        status: "init",
        synced: false,
        connects: 0,
        disconnects: 0,
      };
    }
  }, []);

  const onProvider = useCallback((provider: WebsocketProvider) => {
    provider.on("status", ({ status: s }: { status: string }) => {
      const st = window.__e2e!;
      st.status = s;
      if (s === "connected") st.connects++;
      if (s === "disconnected") st.disconnects++;
      setStatus(s);
      setConnects(st.connects);
    });
    provider.on("sync", (isSynced: boolean) => {
      window.__e2e!.synced = isSynced;
    });
  }, []);

  if (!router.isReady) return null;
  const room = String(router.query.room ?? "");
  const uid = String(router.query.uid ?? "");
  const syncUrl = router.query.syncUrl ? String(router.query.syncUrl) : undefined;
  if (!room || !uid) return <p>Missing ?room=&amp;uid=</p>;

  return (
    <main style={{ fontFamily: "sans-serif", padding: 8 }}>
      <div data-testid="e2e-meta" style={{ fontSize: 12, marginBottom: 6 }}>
        room=<span data-testid="e2e-room">{room}</span> uid=<span data-testid="e2e-uid">{uid}</span> status=
        <span data-testid="e2e-status">{status}</span> connects=<span data-testid="e2e-connects">{connects}</span>
      </div>
      <Editor roomId={room} language="plaintext" syncUrl={syncUrl} token={`test-token-${uid}`} onProvider={onProvider} />
    </main>
  );
}
