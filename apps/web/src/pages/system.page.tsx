import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Bot, CheckCircle2, Database, Layers, Network, Server, XCircle } from "lucide-react";
import { api, describeError, type SystemStatus } from "../lib/api";
import { useRequireAuth } from "../lib/useRequireAuth";
import { cn } from "../lib/utils";
import { Alert, Badge, Card, Skeleton } from "../components/ui/display";

const REFRESH_MS = 5000;

function fmtUptime(ms: number | null | undefined) {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** Status is never colour alone: icon + word + colour. */
function Health({ ok, okText = "Healthy", badText = "Down" }: { ok: boolean; okText?: string; badText?: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success"><CheckCircle2 className="size-4" />{okText}</span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-destructive"><XCircle className="size-4" />{badText}</span>
  );
}

function ServiceCard({ icon: Icon, title, what, ok, children, testId }: { icon: typeof Server; title: string; what: string; ok: boolean; children?: React.ReactNode; testId?: string }) {
  return (
    <Card className={cn("bg-card/90 p-5 backdrop-blur", !ok && "border-destructive/40")} data-testid={testId} data-ok={ok}>
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{title}</h3>
            <Health ok={ok} />
          </div>
          <p className="text-sm text-muted-foreground">{what}</p>
        </div>
      </div>
      {children && <div className="mt-4 text-sm">{children}</div>}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export default function SystemPage() {
  const auth = useRequireAuth();
  const { getToken, isSignedIn } = auth;
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<SystemStatus>(getToken, "/status"));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [getToken]);

  useEffect(() => {
    if (!isSignedIn) return;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [isSignedIn, load]);

  if (!auth.isLoaded || !auth.isSignedIn) return null;

  const problems = status
    ? [
        !status.redis.ok && "Redis",
        !status.queue.ok && "Job queue",
        !status.ai.ok && "AI service",
        ...status.sync.nodes.filter((n) => !n.ok).map((n) => `sync node ${n.nodeId}`),
      ].filter(Boolean)
    : [];
  const q = status?.queue;
  const inFlight = q ? (q.waiting ?? 0) + (q.active ?? 0) + (q.delayed ?? 0) : 0;
  const load01 = q ? Math.min(1, inFlight / Math.max(1, q.maxQueueLength)) : 0;

  return (
    <div className="container py-10" data-testid="system-page">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
        <p className="mt-1 text-muted-foreground">
          Live health of every service behind codexync. Refreshes every {REFRESH_MS / 1000} seconds
          {status ? ` · last checked ${new Date(status.checkedAt).toLocaleTimeString()}` : ""}.
        </p>
      </div>

      {error && <Alert variant="destructive" className="mb-6"><AlertCircle /><span>{error}</span></Alert>}

      {status && (
        <div
          className={cn(
            "mb-6 flex items-center gap-3 rounded-xl border px-5 py-4",
            problems.length === 0 ? "border-success/30 bg-success/10" : "border-destructive/30 bg-destructive/10"
          )}
          data-testid="system-overall"
          data-healthy={problems.length === 0}
        >
          {problems.length === 0 ? <CheckCircle2 className="size-5 text-success" /> : <XCircle className="size-5 text-destructive" />}
          <span className="font-medium">
            {problems.length === 0 ? "All systems operational" : `Problems with: ${problems.join(", ")}`}
          </span>
        </div>
      )}

      {!status ? (
        <div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <ServiceCard icon={Server} title="API" what="Rooms, auth and roles, run and AI requests" ok={status.api.ok} testId="svc-api">
              <Fact label="Uptime" value={fmtUptime(status.api.uptimeMs)} />
              <Fact label="Mode" value={status.api.nodeEnv} />
            </ServiceCard>
            <ServiceCard icon={Database} title="Redis" what="Sync relay, job queue, AI progress" ok={status.redis.ok} testId="svc-redis">
              <Fact label="Ping" value={status.redis.ok ? `${status.redis.latencyMs} ms` : status.redis.error ?? "—"} />
            </ServiceCard>
            <ServiceCard icon={Bot} title="AI service" what="Code search and verified fixes" ok={status.ai.ok} testId="svc-ai">
              <Fact label="Response" value={status.ai.ok ? `${status.ai.latencyMs} ms` : status.ai.error ?? "—"} />
              <Fact label="LLM provider" value={status.ai.provider ?? "unknown"} />
            </ServiceCard>
            <ServiceCard icon={Layers} title="Run queue" what="Sandbox jobs waiting for a worker" ok={status.queue.ok} testId="svc-queue">
              <div className="mb-3">
                <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                  <span>In flight {inFlight} of {status.queue.maxQueueLength}</span>
                  <span>{Math.round(load01 * 100)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" title={`${inFlight} jobs waiting, running or delayed; new runs get "busy" at ${status.queue.maxQueueLength}`}>
                  <div className="h-full rounded-full bg-chart transition-[width]" style={{ width: `${Math.max(load01 * 100, inFlight > 0 ? 2 : 0)}%` }} />
                </div>
              </div>
              <Fact label="Running now" value={status.queue.active ?? 0} />
              <Fact label="Waiting" value={status.queue.waiting ?? 0} />
              <Fact label="Completed (kept 1 h)" value={status.queue.completed ?? 0} />
              <Fact label="Failed (kept 24 h)" value={status.queue.failed ?? 0} />
              <Fact label="Run limit" value={`${status.queue.ratePerMinute} / min per user`} />
            </ServiceCard>
          </div>

          <h2 className="mb-1 mt-10 flex items-center gap-2 text-lg font-semibold"><Network className="size-5" /> Sync cluster</h2>
          <p className="mb-4 text-muted-foreground">
            {status.sync.loadBalanced
              ? `${status.sync.nodes.length} nodes behind a load balancer. Edits on one node reach the others through Redis, so people on different nodes still edit the same document.`
              : "A single sync node (no load balancer in front)."}
          </p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {status.sync.nodes.map((n) => (
              <Card key={n.nodeId} className={cn("bg-card/90 p-5 backdrop-blur", !n.ok && "border-destructive/40")} data-testid="sync-node" data-ok={n.ok}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold">{n.nodeId}</span>
                  <Health ok={n.ok} />
                </div>
                {n.ok ? (
                  <>
                    <Fact label="Open rooms" value={n.rooms ?? "—"} />
                    <Fact label="Connected clients" value={n.clients ?? "—"} />
                    <Fact label="Uptime" value={fmtUptime(n.uptimeMs)} />
                    <Fact label="Relay: sent / received updates" value={`${n.published ?? "—"} / ${n.received ?? "—"}`} />
                    {n.routedWs != null && <Fact label="Connections routed here" value={n.routedWs} />}
                    <Fact label="Redis link" value={<Badge variant={n.redis === "ready" ? "success" : "warning"}>{n.redis ?? "—"}</Badge>} />
                  </>
                ) : (
                  <p className="text-sm text-destructive">{n.error ?? "Not answering"}. New connections go to the healthy nodes.</p>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
