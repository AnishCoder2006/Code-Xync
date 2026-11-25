/**
 * Test cases: program input (stdin) and optional expected output, shared by everyone in
 * the room. Cases live in the room's Yjs document (map "tests"), so they sync live and are
 * saved with the room like the code. Results of "Run all" are local to this browser.
 *
 *  - Run (header) uses the selected case's input, streaming to the Output tab.
 *  - Run all: one batch request (counts as one run), each case polled for its result.
 *  - Paste many: blocks separated by a line "---"; inside a block, a line "===" splits
 *    input from expected output.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WebsocketProvider } from "y-websocket";
import { CheckCircle2, ClipboardPaste, Loader2, Play, Plus, Trash2, XCircle, ListChecks, CircleDot, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api, describeError, type GetToken } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/form";

export type TestCase = { id: string; name: string; input: string; expected: string; order: number };
type Result =
  | { state: "running" }
  | { state: "pass" | "fail" | "error" | "ran"; stdout: string; stderr: string; status: string; exitCode: number | null; runTimeMs: number | null };

export const MAX_CASES = 10;
const newId = () => Math.random().toString(36).slice(2, 10);

/** Shared test cases from the room document. Writes are no-ops for viewers (the server drops them). */
export function useTestCases(provider: WebsocketProvider | null) {
  const [cases, setCases] = useState<TestCase[]>([]);
  const map = useMemo(() => provider?.doc.getMap<TestCase>("tests") ?? null, [provider]);

  useEffect(() => {
    if (!map) return;
    const read = () => setCases([...map.values()].filter((c) => c && typeof c.id === "string").sort((a, b) => a.order - b.order));
    read();
    map.observe(read);
    return () => map.unobserve(read);
  }, [map]);

  const put = useCallback((c: TestCase) => map?.set(c.id, c), [map]);
  const remove = useCallback((id: string) => map?.delete(id), [map]);
  const addMany = useCallback(
    (items: { input: string; expected: string }[]) => {
      if (!map) return [];
      const existing = [...map.values()];
      let order = existing.reduce((m, c) => Math.max(m, c.order), 0);
      let n = existing.length;
      const created: TestCase[] = [];
      map.doc!.transact(() => {
        for (const it of items.slice(0, Math.max(0, MAX_CASES - existing.length))) {
          const c = { id: newId(), name: `Case ${++n}`, input: it.input, expected: it.expected, order: ++order };
          map.set(c.id, c);
          created.push(c);
        }
      });
      return created;
    },
    [map]
  );
  return { cases, put, remove, addMany };
}

/** "Paste many" format: blocks split by a line "---"; "===" splits input / expected output. */
export function parseCases(text: string): { input: string; expected: string }[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/^-{3,}[ \t]*$/m)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const [input, ...rest] = block.split(/^={3,}[ \t]*$/m);
      return { input: input.replace(/\n+$/, "") + "\n", expected: rest.join("").replace(/^\n+|\n+$/g, "") };
    });
}

/** Output matches when it's the same apart from trailing spaces and blank lines at the end. */
export const outputsMatch = (actual: string, expected: string) => {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
  return norm(actual) === norm(expected);
};

/** A textarea bound to a shared value: local while you type, remote updates otherwise. */
function SharedField({ value, onCommit, readOnly, ...rest }: { value: string; onCommit: (v: string) => void; readOnly: boolean } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = (v: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(v), 350);
  };
  return (
    <Textarea
      {...rest}
      value={draft}
      readOnly={readOnly}
      spellCheck={false}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        clearTimeout(timer.current);
        if (draft !== value) onCommit(draft);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
    />
  );
}

const ICON: Record<string, { icon: typeof CheckCircle2; cls: string; label: string }> = {
  pass: { icon: CheckCircle2, cls: "text-success", label: "Passed" },
  fail: { icon: XCircle, cls: "text-destructive", label: "Wrong output" },
  error: { icon: AlertTriangle, cls: "text-warning", label: "Error" },
  ran: { icon: CircleDot, cls: "text-muted-foreground", label: "Ran" },
};

type Props = {
  provider: WebsocketProvider | null;
  roomId: string;
  language: string;
  getCode: () => string;
  getToken: GetToken;
  readOnly: boolean;
  /** Why runs are blocked (viewer / language), or null. */
  runBlockedReason: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Run the selected case in the terminal (the header's Run button does the same). */
  onRunOne: () => void;
  onRateLimited: (retryAfter: number) => void;
};

export function TestCasesPanel({ provider, roomId, language, getCode, getToken, readOnly, runBlockedReason, selectedId, onSelect, onRunOne, onRateLimited }: Props) {
  const { cases, put, remove, addMany } = useTestCases(provider);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const selected = cases.find((c) => c.id === selectedId) ?? cases[0] ?? null;

  useEffect(() => {
    if (selected && selected.id !== selectedId) onSelect(selected.id);
    if (!selected && selectedId) onSelect(null);
  }, [selected, selectedId, onSelect]);

  const add = () => {
    const [c] = addMany([{ input: "", expected: "" }]);
    if (c) onSelect(c.id);
    else toast.error(`A room can have up to ${MAX_CASES} test cases.`);
  };

  const importPaste = () => {
    const parsed = parseCases(paste);
    if (parsed.length === 0) return toast.error("Nothing to add. Paste at least one input.");
    const created = addMany(parsed);
    if (created.length < parsed.length) toast.warning(`Added ${created.length} of ${parsed.length}: a room can have up to ${MAX_CASES} test cases.`);
    else toast.success(`Added ${created.length} test ${created.length === 1 ? "case" : "cases"}`);
    if (created[0]) onSelect(created[0].id);
    setPaste("");
    setPasting(false);
  };

  const runAll = async () => {
    if (cases.length === 0 || running || runBlockedReason) return;
    setRunning(true);
    setResults(Object.fromEntries(cases.map((c) => [c.id, { state: "running" } as Result])));
    try {
      const { jobIds } = await api<{ jobIds: string[] }>(getToken, "/execution/batch", {
        body: { roomId, code: getCode(), language, cases: cases.map((c) => ({ stdin: c.input })) },
      });
      const deadline = Date.now() + 90_000;
      await Promise.all(
        jobIds.map(async (jobId, k) => {
          const tc = cases[k];
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 700));
            const r = await api<{ done: boolean; status: string; exitCode: number | null; stdout: string; stderr: string; runTimeMs: number | null }>(
              getToken,
              `/execution/${encodeURIComponent(jobId)}/result`
            ).catch(() => null);
            if (!r?.done) continue;
            const ok = r.status === "passed";
            const state: Result["state"] = !ok ? "error" : tc.expected.trim() === "" ? "ran" : outputsMatch(r.stdout, tc.expected) ? "pass" : "fail";
            setResults((prev) => ({ ...prev, [tc.id]: { state, ...r } }));
            return;
          }
          setResults((prev) => ({ ...prev, [tc.id]: { state: "error", status: "timeout", exitCode: null, stdout: "", stderr: "No result after 90 s.", runTimeMs: null } }));
        })
      );
    } catch (err) {
      setResults({});
      toast.error(describeError(err, "run"));
      const e = err as { status?: number; retryAfter?: number | null };
      if (e.status === 429) onRateLimited(e.retryAfter ?? 60);
    } finally {
      setRunning(false);
    }
  };

  const done = Object.values(results).filter((r) => r.state !== "running") as Exclude<Result, { state: "running" }>[];
  const passed = done.filter((r) => r.state === "pass").length;
  const graded = done.filter((r) => r.state === "pass" || r.state === "fail").length;
  const res = selected ? results[selected.id] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tests-panel">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        {cases.map((c) => {
          const r = results[c.id];
          const meta = r && r.state !== "running" ? ICON[r.state] : null;
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                selected?.id === c.id ? "border-brand/50 bg-brand/10 text-foreground" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              data-testid="test-case-tab"
              aria-pressed={selected?.id === c.id}
            >
              {r?.state === "running" ? <Loader2 className="size-3.5 animate-spin" /> : meta ? <meta.icon className={cn("size-3.5", meta.cls)} aria-label={meta.label} /> : null}
              {c.name}
            </button>
          );
        })}
        {!readOnly && cases.length < MAX_CASES && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={add} data-testid="add-test-case"><Plus />Add case</Button>
        )}
        {!readOnly && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPasting((p) => !p)} aria-pressed={pasting} data-testid="paste-cases">
            <ClipboardPaste />Paste many
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {graded > 0 && !running && (
            <span className={cn("text-xs font-medium", passed === graded ? "text-success" : "text-destructive")} data-testid="tests-summary">
              {passed}/{graded} passed
            </span>
          )}
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={runAll} disabled={cases.length === 0 || running || !!runBlockedReason}
            title={runBlockedReason ?? "Run every case (counts as one run)"} data-testid="run-all-tests">
            {running ? <Loader2 className="animate-spin" /> : <ListChecks />} Run all{cases.length ? ` (${cases.length})` : ""}
          </Button>
        </div>
      </div>

      {pasting ? (
        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-2 p-2">
          <p className="text-xs text-muted-foreground">
            Paste several inputs. Put a line with <code className="rounded bg-muted px-1 font-mono">---</code> between cases. To add an expected output,
            put a line with <code className="rounded bg-muted px-1 font-mono">===</code> after the input, then the output.
          </p>
          <Textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            spellCheck={false}
            className="h-full min-h-0 resize-none font-mono text-[13px]"
            placeholder={"3\n1 2 3\n===\n6\n---\n2\n10 20\n===\n30"}
            aria-label="Paste test cases"
            data-testid="paste-cases-input"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={importPaste} data-testid="paste-cases-add">
              Add {parseCases(paste).length || ""} {parseCases(paste).length === 1 ? "case" : "cases"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>Cancel</Button>
          </div>
        </div>
      ) : !selected ? (
        <div className="grid flex-1 place-items-center p-4 text-center text-sm text-muted-foreground">
          <div className="grid max-w-md gap-2">
            <p className="font-medium text-foreground">Test your program with input</p>
            <p>Add a case with the input your program reads (stdin) and, if you like, the output you expect. Run checks one; Run all checks every case at once.</p>
            {!readOnly && (
              <div className="mt-1 flex justify-center gap-2">
                <Button size="sm" variant="outline" onClick={add}><Plus />Add a case</Button>
                <Button size="sm" variant="ghost" onClick={() => setPasting(true)}><ClipboardPaste />Paste many</Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto p-2 md:grid-cols-[1fr_1fr_1fr]">
          <label className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-1">
            <span className="text-xs font-medium text-muted-foreground">Input (stdin)</span>
            <SharedField
              key={`${selected.id}-in`}
              value={selected.input}
              onCommit={(v) => put({ ...selected, input: v })}
              readOnly={readOnly}
              className="h-full min-h-[96px] resize-none font-mono text-[13px]"
              placeholder={"5\n1 2 3 4 5"}
              data-testid="test-input"
            />
          </label>
          <label className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-1">
            <span className="text-xs font-medium text-muted-foreground">Expected output (optional)</span>
            <SharedField
              key={`${selected.id}-out`}
              value={selected.expected}
              onCommit={(v) => put({ ...selected, expected: v })}
              readOnly={readOnly}
              className="h-full min-h-[96px] resize-none font-mono text-[13px]"
              placeholder="15"
              data-testid="test-expected"
            />
          </label>
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-1">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              Your output
              {res && res.state !== "running" && (
                <span className={cn("inline-flex items-center gap-1", ICON[res.state].cls)} data-testid="test-result">
                  · {res.state === "error" ? (res.status === "timeout" ? "Time limit" : `Exit code ${res.exitCode ?? "?"}`) : ICON[res.state].label}
                  {res.runTimeMs != null && <span className="text-muted-foreground">· {(res.runTimeMs / 1000).toFixed(2)} s</span>}
                </span>
              )}
            </span>
            <pre
              className={cn(
                "min-h-[96px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-[13px]",
                res?.state === "fail" && "border-destructive/40",
                res?.state === "pass" && "border-success/40"
              )}
              data-testid="test-actual"
            >
              {!res ? <span className="text-muted-foreground">Run all to check this case.</span> : res.state === "running" ? <span className="text-muted-foreground">Running…</span> : (
                <>
                  {res.stdout}
                  {res.stderr && <span className="text-destructive">{res.stderr}</span>}
                </>
              )}
            </pre>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={onRunOne} disabled={!!runBlockedReason || running} title={runBlockedReason ?? "Run with this input and watch it in Output"} data-testid="run-this-case">
                <Play />Run this case
              </Button>
              {!readOnly && (
                <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={`Delete ${selected.name}`} onClick={() => remove(selected.id)} data-testid="delete-test-case">
                  <Trash2 />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
