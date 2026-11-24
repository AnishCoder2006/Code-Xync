/**
 * AI fix panel: prompt -> live progress steps (SSE, plan step 1.2) -> side-by-side diff ->
 * Accept / Reject. The live document changes only through Accept, which the API applies
 * after a stale check; a stale patch shows "the file changed while the AI was working".
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffEditor } from "@monaco-editor/react";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, RotateCcw, Sparkles, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api, describeError, fileNameFor, type GetToken } from "../lib/api";
import { openProgressStream, type ProgressEvent } from "../lib/aiProgress";
import { uuid } from "../lib/util";
import { languageInfo } from "../lib/languages";
import { MONACO_THEME, defineMonacoThemes } from "../lib/monacoTheme";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Label, Textarea } from "./ui/form";
import { Alert, Badge, Separator, Spinner } from "./ui/display";

type FixResult = {
  interactionId: string;
  status: string; // verified | unverified_no_test | exhausted | apply_error | error
  patch: string;
  patched_text?: string | null;
  original_code?: string | null;
  new_code?: string | null;
  function_name?: string | null;
  error_message?: string | null;
  llm_calls: number;
  total_cost_usd: number;
};

type Phase = "idle" | "running" | "review" | "failed" | "accepting" | "accepted" | "stale";

type Props = {
  roomId: string;
  language: string;
  getCode: () => string;
  getToken: GetToken;
  /** Non-null: the panel explains why AI fixes are unavailable (e.g. viewer). */
  disabledReason: string | null;
  /** Element over the editor where the diff is shown. */
  diffHost: HTMLElement | null;
  theme: "light" | "dark";
  onClose: () => void;
  /** Inside the room's tabbed panel: the tab bar already names it and has the close button. */
  embedded?: boolean;
};

const REASONS: Record<string, string> = {
  llm_parse_error: "the AI's answer was malformed",
  function_not_found: "the AI targeted a function that isn't in the file",
};

function stepLabel(e: ProgressEvent): string {
  switch (e.step) {
    case "context": return "Reading the file";
    case "generating": return e.attempt && e.attempt > 1 ? `Writing a fix (attempt ${e.attempt})` : "Writing a fix";
    case "applying": return "Applying the edit to a copy";
    case "testing": return "Running it in the sandbox";
    case "retrying": {
      const why = (e.reason && REASONS[e.reason]) || "the sandbox run failed";
      return `Attempt ${e.retry ?? (e.attempt ?? 2) - 1} failed: ${why}. Retrying`;
    }
    case "done": return e.status === "verified" ? "Fix verified by its test" : "Fix ready for review";
    case "failed": return "Couldn't produce a working fix";
    default: return e.step;
  }
}

const isFixUsable = (s: string) => s === "verified" || s === "unverified_no_test";

function StepIcon({ kind }: { kind: "active" | "ok" | "good" | "warn" | "bad" }) {
  const base = "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full";
  if (kind === "active") return <span className={cn(base, "bg-accent text-accent-foreground")}><Spinner className="size-3" /></span>;
  if (kind === "good") return <span className={cn(base, "bg-success text-success-foreground")}><Check className="size-3" strokeWidth={3} /></span>;
  if (kind === "warn") return <span className={cn(base, "bg-warning/15 text-warning")}><RotateCcw className="size-3" strokeWidth={2.5} /></span>;
  if (kind === "bad") return <span className={cn(base, "bg-destructive/15 text-destructive")}><X className="size-3" strokeWidth={3} /></span>;
  return <span className={cn(base, "border bg-card text-muted-foreground")}><Check className="size-3" strokeWidth={2.5} /></span>;
}

export function AIDiffPanel({ roomId, language, getCode, getToken, disabledReason, diffHost, theme, onClose, embedded = false }: Props) {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [result, setResult] = useState<FixResult | null>(null);
  const [baseCode, setBaseCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = async () => {
    const text = prompt.trim();
    if (!text || disabledReason) return;
    const code = getCode();
    if (!code.trim()) {
      setError("The file is empty. Write some code first, then ask for a fix.");
      setPhase("failed");
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("running");
    setEvents([]);
    setResult(null);
    setError(null);
    setBaseCode(code);

    const progressId = uuid();
    const stream = openProgressStream({
      progressId,
      roomId,
      getToken,
      signal: ctrl.signal,
      onEvent: (e) => setEvents((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e])),
    });
    // Events are replayed to late subscribers, so this wait only keeps the list tidy.
    await Promise.race([stream.ready, new Promise((r) => setTimeout(r, 3000))]);

    try {
      const res = await api<FixResult>(getToken, "/ai/fix", {
        body: { roomId, code, prompt: text, language, filePath: fileNameFor(language), progressId },
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      setResult(res);
      setPhase(isFixUsable(res.status) && res.patched_text ? "review" : "failed");
      // Let the stream deliver its last event, then stop listening.
      setTimeout(() => ctrl.abort(), 1500);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(describeError(err, "ai"));
      setPhase("failed");
      ctrl.abort();
    }
  };

  const accept = async () => {
    if (!result) return;
    setPhase("accepting");
    setError(null);
    try {
      await api(getToken, `/ai/${result.interactionId}/accept`, {
        method: "PATCH",
        body: { oldRangeText: result.original_code, newCode: result.new_code },
      });
      setPhase("accepted");
      toast.success("Fix applied", { description: "Everyone in the room now sees the change." });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data?.stale) {
        setPhase("stale");
      } else {
        setError(describeError(err, "ai"));
        setPhase("review");
      }
    }
  };

  const reject = async () => {
    if (!result) return;
    const id = result.interactionId;
    setPhase("idle");
    setResult(null);
    setEvents([]);
    await api(getToken, `/ai/${id}`, { method: "PATCH", body: { status: "rejected" } }).catch(() => {});
  };

  const running = phase === "running";
  const showDiff = result?.patched_text && (phase === "review" || phase === "accepting" || phase === "stale");
  const last = events[events.length - 1];

  const diff = showDiff && (
    <div className="absolute inset-0 z-10 flex flex-col bg-card" data-testid="ai-diff">
      <div className="flex flex-wrap items-center gap-3 border-b bg-accent/60 px-3 py-2">
        <Sparkles className="size-4 text-accent-foreground" />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 text-sm">
          <strong className="font-semibold">AI proposal</strong>
          <span className="text-muted-foreground">
            {result!.function_name ? <>changes <code className="rounded bg-muted px-1 font-mono text-xs">{result!.function_name}</code> · </> : null}
            left: current · right: proposed
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={reject} disabled={phase === "accepting"} data-testid="ai-reject">
            <X /> Reject
          </Button>
          <Button size="sm" variant="success" onClick={accept} disabled={phase !== "review"} data-testid="ai-accept">
            {phase === "accepting" ? <Spinner /> : <Check />}
            Accept
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DiffEditor
          height="100%"
          language={languageInfo(language).monaco}
          original={baseCode}
          modified={result!.patched_text!}
          theme={MONACO_THEME[theme]}
          beforeMount={defineMonacoThemes}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false }}
        />
      </div>
    </div>
  );

  return (
    <section className="flex h-full flex-col gap-4 overflow-y-auto p-4" aria-label="AI fix" data-testid="ai-panel">
      <div className={cn("flex items-center justify-between", embedded && "hidden")}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-accent text-accent-foreground"><Sparkles className="size-3.5" /></span>
          AI fix
        </h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close AI panel"><X /></Button>
      </div>

      {disabledReason ? (
        <Alert variant="info" data-testid="ai-disabled"><AlertCircle /><span>{disabledReason}</span></Alert>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="ai-prompt" className="text-muted-foreground">What should change?</Label>
            <Textarea
              id="ai-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate();
              }}
              placeholder="e.g. add() returns the wrong result for negative numbers"
              disabled={running || phase === "accepting"}
              data-testid="ai-prompt"
            />
            <p className="text-xs text-muted-foreground">
              The AI edits a copy and tests it in the sandbox. Nothing changes until you accept. <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">Ctrl</kbd>+<kbd className="rounded border bg-muted px-1 font-mono text-[10px]">Enter</kbd>
            </p>
          </div>
          <Button onClick={generate} disabled={running || phase === "accepting" || !prompt.trim()} data-testid="ai-generate">
            {running ? <Spinner /> : phase === "stale" ? <RotateCcw /> : <Sparkles />}
            {running ? "Working…" : phase === "stale" ? "Regenerate" : "Generate fix"}
          </Button>
        </div>
      )}

      {events.length > 0 && (
        <>
          <Separator />
          <ol className="grid gap-1" aria-label="Progress" data-testid="ai-steps">
            {events.map((e) => {
              const current = running && e === last && e.step !== "done" && e.step !== "failed";
              const kind = e.step === "failed" ? "bad" : e.step === "retrying" ? "warn" : e.step === "done" ? "good" : current ? "active" : "ok";
              return (
                <li
                  key={e.seq}
                  className={cn("flex items-start gap-2.5 py-1 text-[13px]", kind === "ok" && "text-muted-foreground", kind === "warn" && "text-warning")}
                  data-step={e.step}
                  data-attempt={e.attempt ?? ""}
                  data-testid="ai-step"
                >
                  <StepIcon kind={kind} />
                  <span>{stepLabel(e)}</span>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {result && phase !== "idle" && phase !== "running" && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground" data-testid="ai-summary">
          <span data-testid="ai-attempts">{result.llm_calls} {result.llm_calls === 1 ? "attempt" : "attempts"}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="ai-cost" className="font-mono">${result.total_cost_usd.toFixed(4)}</span>
          {result.status === "verified" && <Badge variant="success"><CheckCircle2 className="size-3" />Verified by test</Badge>}
          {result.status === "unverified_no_test" && (
            <Badge variant="outline" title="It ran cleanly in the sandbox, but there was no test to check its behaviour">Ran cleanly · not test-verified</Badge>
          )}
        </div>
      )}

      {phase === "review" && <p className="text-[13px] text-muted-foreground">Review the change over the editor, then accept or reject it.</p>}

      {phase === "failed" && (
        <Alert variant="destructive" data-testid="ai-failed">
          <XCircle />
          <span>
            {error ?? (result?.error_message ? `The fix didn't pass: ${result.error_message.slice(0, 300)}` : "The AI couldn't produce a working fix. Try describing the problem differently.")}
          </span>
        </Alert>
      )}
      {error && phase === "review" && <Alert variant="destructive"><AlertCircle /><span>{error}</span></Alert>}

      {phase === "stale" && (
        <Alert variant="warning" data-testid="ai-stale">
          <AlertTriangle />
          <span>
            The file changed while the AI was working, so this fix no longer matches the code. Regenerate to get a fix for
            the current version.
          </span>
        </Alert>
      )}

      {phase === "accepted" && (
        <Alert variant="success" role="status" data-testid="ai-accepted">
          <CheckCircle2 />
          <span>Applied. Everyone in the room now sees the change.</span>
        </Alert>
      )}

      {diff && diffHost ? createPortal(diff, diffHost) : diff}
    </section>
  );
}

export default AIDiffPanel;
