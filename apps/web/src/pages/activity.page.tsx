import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Play, RefreshCw, Sparkles } from "lucide-react";
import { FIX_STATUS, RUN_STATUS, api, describeError, type Activity } from "../lib/api";
import { useRequireAuth } from "../lib/useRequireAuth";
import { languageInfo } from "../lib/languages";
import { timeAgo } from "../lib/util";
import { Button } from "../components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from "../components/ui/display";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/overlay";

function StatTile({ label, value, hint, icon: Icon }: { label: string; value: number | string; hint: string; icon: typeof Play }) {
  return (
    <Card className="bg-card/90 p-5 backdrop-blur">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon className="size-4" /> {label}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </Card>
  );
}

function RoomLink({ room }: { room?: { id: string; title: string; language: string } }) {
  if (!room) return null;
  const lang = languageInfo(room.language);
  return (
    <Link href={`/room/${encodeURIComponent(room.id)}`} className="inline-flex min-w-0 items-center gap-1.5 font-medium hover:underline">
      <span className="size-2 shrink-0 rounded-full" style={{ background: lang.color }} aria-hidden="true" />
      <span className="truncate">{room.title}</span>
    </Link>
  );
}

export default function ActivityPage() {
  const auth = useRequireAuth();
  const { getToken, isSignedIn } = auth;
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<Activity>(getToken, "/me/activity"));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (isSignedIn) load();
  }, [isSignedIn, load]);

  if (!auth.isLoaded || !auth.isSignedIn) return null;
  const acceptRate = data && data.summary.aiFixes7d > 0 ? Math.round((data.summary.accepted7d / data.summary.aiFixes7d) * 100) : null;

  return (
    <div className="container py-10" data-testid="activity-page">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your activity</h1>
          <p className="mt-1 text-muted-foreground">Everything you ran in the sandbox and every AI fix you asked for, across all your rooms.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      {error && <Alert variant="destructive" className="mb-6"><AlertCircle /><span>{error}</span></Alert>}

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        {data ? (
          <>
            <StatTile icon={Play} label="Runs, last 7 days" value={data.summary.runs7d} hint="Programs executed in the sandbox" />
            <StatTile icon={Sparkles} label="AI fixes, last 7 days" value={data.summary.aiFixes7d} hint="Fix requests you made" />
            <StatTile
              icon={CheckCircle2}
              label="Accepted"
              value={data.summary.accepted7d}
              hint={acceptRate === null ? "No AI fixes yet" : `${acceptRate}% of your AI fixes were applied`}
            />
          </>
        ) : (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-[124px] rounded-xl" />)
        )}
      </div>

      <Tabs defaultValue="runs">
        <TabsList className="w-full max-w-sm">
          <TabsTrigger value="runs">Runs{data ? ` (${data.runs.length})` : ""}</TabsTrigger>
          <TabsTrigger value="fixes">AI fixes{data ? ` (${data.aiFixes.length})` : ""}</TabsTrigger>
        </TabsList>

        <TabsContent value="runs">
          <Card className="bg-card/90 backdrop-blur">
            <CardHeader className="pb-2"><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
            <CardContent>
              {!data ? (
                <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
              ) : data.runs.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground">No runs yet. Open a room and press Run.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="activity-runs">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Room</th>
                        <th className="py-2 pr-4 font-medium">Result</th>
                        <th className="py-2 pr-4 text-right font-medium">Duration</th>
                        <th className="py-2 text-right font-medium">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.runs.map((r) => {
                        const st = RUN_STATUS[r.status] ?? { label: r.status, tone: "secondary" as const };
                        return (
                          <tr key={r.jobId} className="border-b last:border-0">
                            <td className="max-w-[260px] py-2.5 pr-4"><RoomLink room={r.room} /></td>
                            <td className="py-2.5 pr-4"><Badge variant={st.tone}>{st.label}</Badge></td>
                            <td className="py-2.5 pr-4 text-right tabular-nums">{r.runTimeMs != null ? `${(r.runTimeMs / 1000).toFixed(2)} s` : "—"}</td>
                            <td className="whitespace-nowrap py-2.5 text-right text-muted-foreground">{timeAgo(r.createdAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fixes">
          <Card className="bg-card/90 backdrop-blur">
            <CardHeader className="pb-2"><CardTitle className="text-base">Recent AI fixes</CardTitle></CardHeader>
            <CardContent>
              {!data ? (
                <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
              ) : data.aiFixes.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground">No AI fixes yet. Open a room, choose AI fix, and describe a bug.</p>
              ) : (
                <ul className="divide-y" data-testid="activity-fixes">
                  {data.aiFixes.map((f) => {
                    const st = FIX_STATUS[f.status] ?? { label: f.status, tone: "secondary" as const };
                    return (
                      <li key={f.id} className="grid gap-1 py-3">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <RoomLink room={f.room} />
                          <Badge variant={st.tone}>{st.label}</Badge>
                          <span className="ml-auto text-muted-foreground">{timeAgo(f.createdAt)}</span>
                        </div>
                        <p className="text-sm">{f.prompt}</p>
                        <p className="text-xs text-muted-foreground">
                          {f.attempts != null ? `${f.attempts} ${f.attempts === 1 ? "attempt" : "attempts"}` : "attempts not recorded"}
                          {f.costUsd != null ? ` · $${f.costUsd.toFixed(4)}` : ""}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
