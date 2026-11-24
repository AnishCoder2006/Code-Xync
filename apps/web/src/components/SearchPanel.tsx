/**
 * Code search (Phase 4): hybrid vector + keyword search over this room's code, run by the
 * AI service. The index updates about 5 seconds after people stop typing.
 */
import { useState, type FormEvent } from "react";
import { AlertCircle, CornerDownRight, Search as SearchIcon } from "lucide-react";
import { api, describeError, type GetToken, type SearchHit } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/form";
import { Alert, Badge, Skeleton } from "./ui/display";

type Props = { roomId: string; getToken: GetToken; onReveal: (start: number, end: number) => void };

const EXAMPLES = ["where is the total calculated", "error handling", "parse the input"];

export function SearchPanel({ roomId, getToken, onReveal }: Props) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ phase: "idle" | "loading" | "done" | "error"; hits: SearchHit[]; error?: string; asked?: string }>({ phase: "idle", hits: [] });

  const search = async (q: string) => {
    const text = q.trim();
    if (!text) return;
    setState({ phase: "loading", hits: [], asked: text });
    try {
      const hits = await api<SearchHit[]>(getToken, "/ai/search", { body: { roomId, query: text, limit: 8 } });
      setState({ phase: "done", hits, asked: text });
    } catch (err) {
      setState({ phase: "error", hits: [], error: describeError(err), asked: text });
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    search(query);
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-testid="search-panel">
      <div>
        <h2 className="text-[15px] font-semibold">Search this room's code</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe what you're looking for in plain words. Results rank by meaning and by name, best match first.
        </p>
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. where is the offset computed" data-testid="search-input" aria-label="Search query" />
        <Button type="submit" disabled={!query.trim() || state.phase === "loading"} data-testid="search-submit" aria-label="Search">
          <SearchIcon />
        </Button>
      </form>

      {state.phase === "idle" && (
        <div className="grid gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Try</span>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => { setQuery(ex); search(ex); }} className="rounded-full border bg-muted/40 px-3 py-1 text-sm hover:bg-accent hover:text-accent-foreground">
                {ex}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">New edits become searchable about 5 seconds after typing stops.</p>
        </div>
      )}

      {state.phase === "loading" && (
        <div className="grid gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      )}

      {state.phase === "error" && (
        <Alert variant="destructive"><AlertCircle /><span>{state.error}</span></Alert>
      )}

      {state.phase === "done" && state.hits.length === 0 && (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="search-empty">
          Nothing matched "{state.asked}". If the code was just written, wait a few seconds for it to be indexed and try again.
        </div>
      )}

      {state.phase === "done" && state.hits.length > 0 && (
        <ol className="grid gap-2" data-testid="search-results">
          {state.hits.map((h, i) => (
            <li key={`${h.path}:${h.start_line}:${i}`}>
              <button
                type="button"
                onClick={() => onReveal(h.start_line, h.end_line)}
                className="group w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
                data-testid="search-hit"
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono font-medium">{h.function_name || h.ast_type || "code"}</span>
                  <span className="text-muted-foreground">lines {h.start_line}–{h.end_line}</span>
                  <Badge variant="outline" className="ml-auto font-mono" title="Relevance score (higher is better)">{h.score.toFixed(3)}</Badge>
                </div>
                <pre className="mt-2 max-h-28 overflow-hidden whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-xs leading-5">{h.text.split("\n").slice(0, 6).join("\n")}</pre>
                <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  <CornerDownRight className="size-3" /> Show in editor
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
