import { useRouter } from "next/router";
import { useState, useCallback, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import dynamic from "next/dynamic";

// Dynamic imports — both components use browser-only APIs
const Editor = dynamic(() => import("../../components/Editor").then((m) => m.Editor), { ssr: false });
const Terminal = dynamic(() => import("../../components/Terminal").then((m) => m.Terminal), { ssr: false });

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface FixState {
  interactionId: string;
  original: string;   // code at the time the AI was triggered
  patch: string;      // AI-proposed version
  original_code?: string;
  new_code?: string;
}

export default function Room() {
  const router = useRouter();
  const roomId = router.query.id as string;
  const { getToken } = useAuth();

  // language is simplified to "javascript" for Phase 2; extend later
  const [language] = useState("javascript");

  // jobId drives Terminal visibility & subscription scope
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  // Fix state — non-null while Accept/Reject bar is shown
  const [fixState, setFixState] = useState<FixState | null>(null);

  // Stable ref to the Editor's getCode/applyPatch helper, set via onReady
  const getCodeRef = useRef<any>(null);
  const handleEditorReady = useCallback((helpers: any) => {
    getCodeRef.current = helpers;
  }, []);

  // ── Run ─────────────────────────────────────────────────────────────────────
  const handleRun = async () => {
    if (!roomId) return;
    const code = typeof getCodeRef.current === "function" ? getCodeRef.current() : getCodeRef.current?.getCode?.() ?? "";
    const token = await getToken();

    setIsRunning(true);
    const res = await fetch(`${API}/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ roomId, code, language }),
    });

    if (!res.ok) {
      alert("Failed to enqueue job");
      setIsRunning(false);
      return;
    }
    const { jobId } = await res.json();
    setActiveJobId(jobId); // Terminal subscribes once this is non-null
  };

  // ── AI Fix ──────────────────────────────────────────────────────────────────
  const handleAiFix = async () => {
    if (!roomId) return;
    const code = typeof getCodeRef.current === "function" ? getCodeRef.current() : getCodeRef.current?.getCode?.() ?? "";
    const prompt = window.prompt("Describe what you want fixed:") ?? "";
    if (!prompt.trim()) return;

    const token = await getToken();
    const res = await fetch(`${API}/ai/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ roomId, code, prompt, language }),
    });

    if (!res.ok) { alert("AI request failed"); return; }
    const data = await res.json();
    const { patch, interactionId, original_code, new_code, patched_text } = data;
    setFixState({
      interactionId,
      original: code,
      patch: patched_text ?? patch,
      original_code,
      new_code,
    });
  };

  // ── Accept — apply patch through sync service /apply-patch in ONE transaction ──
  const handleAccept = async () => {
    if (!fixState) return;
    const token = await getToken();
    const res = await fetch(`${API}/ai/${fixState.interactionId}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        oldRangeText: fixState.original_code,
        newCode: fixState.new_code,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const message = err.error || "Failed to accept fix";
      if (res.status === 409) {
        // On 409 conflict: keep diff open so user can review the change, do NOT clear fixState
        alert(`Conflict: ${message}`);
        return;
      }
      alert(message);
      setFixState(null);
      return;
    }
    setFixState(null);
  };

  // ── Reject — server-audited, never a silent local state reset ────────────
  const handleReject = async () => {
    if (!fixState) return;
    const token = await getToken();
    await fetch(`${API}/ai/${fixState.interactionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "rejected" }),
    });
    setFixState(null); // discard diff, editor reverts to live Yjs document
  };

  return (
    <div style={{ fontFamily: "monospace", padding: "16px", background: "#121212", minHeight: "100vh", color: "#fff" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
        <span style={{ flex: 1, fontWeight: "bold" }}>Room: {roomId}</span>
        <button onClick={handleRun} disabled={isRunning}
          style={{ padding: "6px 14px", background: "#22c55e", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer" }}>
          ▶ Run
        </button>
        <button onClick={handleAiFix} disabled={!!fixState}
          style={{ padding: "6px 14px", background: "#6366f1", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer" }}>
          ✦ AI Fix
        </button>
      </div>

      {/* Accept / Reject bar */}
      {fixState && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px",
          background: "#1e293b", borderRadius: 4, marginBottom: "8px", border: "1px solid #6366f1" }}>
          <span style={{ flex: 1, color: "#a5b4fc" }}>✦ AI proposed a fix — review the diff below</span>
          <button onClick={handleAccept}
            style={{ padding: "5px 14px", background: "#22c55e", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer" }}>
            Accept
          </button>
          <button onClick={handleReject}
            style={{ padding: "5px 14px", background: "#ef4444", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer" }}>
            Reject
          </button>
        </div>
      )}

      {/* Monaco Editor (diff mode when fixState is set) */}
      {roomId && (
        <Editor
          roomId={roomId}
          language={language}
          onReady={handleEditorReady}
          diffOriginal={fixState?.original ?? null}
          diffModified={fixState?.patch ?? null}
        />
      )}

      {/* XTerm terminal — visible while active job is present, stays readable on completion */}
      {roomId && (
        <Terminal
          roomId={roomId}
          jobId={activeJobId}
          onJobEnd={() => setIsRunning(false)}
        />
      )}
    </div>
  );
}
