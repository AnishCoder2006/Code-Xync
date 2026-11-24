/**
 * Room history: recent sandbox runs (Phase 3) and AI fixes (Phase 5), from the audit
 * tables the API writes (ExecutionLog, AIInteraction).
 */
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Play, RefreshCw, Sparkles } from "lucide-react";
import { FIX_STATUS, RUN_STATUS, api, describeError, type GetToken, type RoomHistory } from "../lib/api";
import { timeAgo } from "../lib/util";
import { Button } from "./ui/button";
import { Alert, Badge, Skeleton } from "./ui/display";

type Props = { roomId: string; getToken: GetToken; refreshKey: number };

export function HistoryPanel({ roomId, getToken, refreshKey }: Props) {
  const [data, setData] = useState<RoomHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<RoomHistory>(getToken, `/rooms/${encodeURIComponent(roomId)}/history`));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [roomId, getToken]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4" data-testid="history-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">Room history</h2>
          <p className="mt-1 text-sm text-muted-foreground">Every run and AI fix in this room, by anyone.</p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh history" disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {error && <Alert variant="destructive"><AlertCircle /><span>{error}</span></Alert>}
      {!data && loading && <div className="grid gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>}

      {data && (
        <>
          <section className="grid gap-2" aria-label="Runs">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Play className="size-3.5" /> Runs <span className="font-normal">({data.runs.length})</span>
            </h3>
            {data.runs.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No runs yet. Press Run to execute the file in the sandbox.</p>
            ) : (
              <ul className="grid gap-1.5" data-testid="history-runs">
                {data.runs.map((r) => {
                  const st = RUN_STATUS[r.status] ?? { label: r.status, tone: "secondary" as const };
                  return (
                    <li key={r.jobId} className="rounded-lg border bg-card px-3 py-2" data-testid="history-run" data-status={r.status}>
                      <div className="flex items-center gap-2 text-sm">
                        <Badge variant={st.tone}>{st.label}</Badge>
                        <span className="truncate font-medium">{r.user?.name ?? "Someone"}</span>
                        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
                          {r.runTimeMs != null ? `${(r.runTimeMs / 1000).toFixed(2)} s · ` : ""}{timeAgo(r.createdAt)}
                        </span>
                      </div>
                      {r.preview && <pre className="mt-1.5 truncate font-mono text-xs text-muted-foreground">{r.preview.split("\n")[0]}</pre>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="grid gap-2" aria-label="AI fixes">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="size-3.5" /> AI fixes <span className="font-normal">({data.aiFixes.length})</span>
            </h3>
            {data.aiFixes.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No AI fixes yet. Open the AI tab and describe a bug.</p>
            ) : (
              <ul className="grid gap-1.5" data-testid="history-fixes">
                {data.aiFixes.map((f) => {
                  const st = FIX_STATUS[f.status] ?? { label: f.status, tone: "secondary" as const };
                  return (
                    <li key={f.id} className="rounded-lg border bg-card px-3 py-2" data-testid="history-fix" data-status={f.status}>
                      <div className="flex items-center gap-2 text-sm">
                        <Badge variant={st.tone}>{st.label}</Badge>
                        <span className="truncate font-medium">{f.user?.name ?? "Someone"}</span>
                        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">{timeAgo(f.createdAt)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm">{f.prompt}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {f.attempts != null ? `${f.attempts} ${f.attempts === 1 ? "attempt" : "attempts"}` : "attempts not recorded"}
                        {f.costUsd != null ? ` · $${f.costUsd.toFixed(4)}` : ""}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
