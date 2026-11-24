import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WebsocketProvider } from "y-websocket";
import { AlertCircle, ArrowLeft, Eye, Play, Sparkles, TerminalSquare } from "lucide-react";
import { ApiError, api, describeError, fileNameFor, languageLabel, roleLabel, type RoomDetail } from "../../lib/api";
import { useSyncUrlOverride } from "../../lib/auth";
import { useRequireAuth } from "../../lib/useRequireAuth";
import { colorFor, useColorScheme, useCountdown } from "../../lib/util";
import { cn } from "../../lib/utils";
import type { ConnState } from "../../components/Editor";
import type { RunEnd } from "../../components/Terminal";
import { ConnectionPill, CopyInvite, PresenceAvatars } from "../../components/RoomHeader";
import { JoinRoomForm } from "../../components/JoinRoomForm";
import { Button } from "../../components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Separator, Skeleton, Spinner } from "../../components/ui/display";
import { Hint } from "../../components/ui/overlay";

// Browser-only components (Monaco, xterm).
const Editor = dynamic(() => import("../../components/Editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <Skeleton className="h-full rounded-none" />,
});
const Terminal = dynamic(() => import("../../components/Terminal").then((m) => m.Terminal), { ssr: false });
const AIDiffPanel = dynamic(() => import("../../components/AIDiffPanel").then((m) => m.AIDiffPanel), { ssr: false });

type Load =
  | { state: "loading" }
  | { state: "ready"; room: RoomDetail }
  | { state: "forbidden" }
  | { state: "error"; message: string };

type Run =
  | { phase: "idle"; last?: RunEnd }
  | { phase: "starting" }
  | { phase: "running"; jobId: string };

const VIEWER_REASON = "You're a viewer in this room: you can read along, but not edit, run code or ask for AI fixes.";

export default function RoomPage() {
  const auth = useRequireAuth();
  const router = useRouter();
  const roomId = typeof router.query.id === "string" ? router.query.id : "";
  const syncOverride = useSyncUrlOverride();
  const scheme = useColorScheme();
  const { getToken, user } = auth;

  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [conn, setConn] = useState<ConnState>("connecting");
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [jobId, setJobId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [diffHost, setDiffHost] = useState<HTMLDivElement | null>(null);
  const getCodeRef = useRef<() => string>(() => "");
  const retryIn = useCountdown(retryAt);

  const fetchRoom = useCallback(async () => {
    if (!roomId) return;
    setLoad({ state: "loading" });
    try {
      const room = await api<RoomDetail>(getToken, `/rooms/${encodeURIComponent(roomId)}`);
      setLoad({ state: "ready", room });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setLoad({ state: "forbidden" });
      else setLoad({ state: "error", message: describeError(err) });
    }
  }, [roomId, getToken]);

  useEffect(() => {
    if (auth.isSignedIn && roomId) fetchRoom();
  }, [auth.isSignedIn, roomId, fetchRoom]);

  const onReady = useCallback((helpers: { getCode: () => string }) => {
    getCodeRef.current = helpers.getCode;
  }, []);
  const onEnd = useCallback((end: RunEnd) => setRun({ phase: "idle", last: end }), []);

  const presenceUser = useMemo(
    () => (user ? { id: user.id, name: user.name, color: colorFor(user.id) } : undefined),
    [user]
  );

  if (!auth.isLoaded || !auth.isSignedIn || !roomId) return null;

  if (load.state === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground" aria-busy="true">
        <Spinner /> Opening room…
      </div>
    );
  }
  if (load.state === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-md" data-testid="room-error">
          <AlertCircle />
          <div className="grid gap-2">
            <span>{load.message}</span>
            <Button size="sm" variant="outline" className="w-fit" onClick={fetchRoom}>Try again</Button>
          </div>
        </Alert>
      </div>
    );
  }
  if (load.state === "forbidden") {
    return (
      <div className="app-backdrop flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-md" data-testid="room-forbidden">
          <CardHeader>
            <CardTitle className="text-lg">Join this room</CardTitle>
            <CardDescription>You're not a member of this room yet. If it has a passcode, ask the person who invited you.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <JoinRoomForm getToken={getToken} roomId={roomId} onJoined={fetchRoom} />
            <Link href="/rooms" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-3" /> Back to your rooms
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const room = load.room;
  const isViewer = room.myRole === "VIEWER";
  const running = run.phase !== "idle";

  const startRun = async () => {
    if (isViewer || running || retryIn > 0) return;
    setRunError(null);
    setRun({ phase: "starting" });
    try {
      const { jobId: id } = await api<{ jobId: string }>(getToken, "/execution", {
        body: { roomId, code: getCodeRef.current(), language: room.language },
      });
      setJobId(id);
      setRun({ phase: "running", jobId: id });
    } catch (err) {
      setRun({ phase: "idle" });
      setRunError(describeError(err, "run"));
      if (err instanceof ApiError && (err.status === 429 || err.status === 503)) {
        setRetryAt(Date.now() + (err.retryAfter ?? (err.status === 503 ? 5 : 60)) * 1000);
      }
    }
  };

  const runLabel = run.phase === "starting" ? "Queuing…" : run.phase === "running" ? "Running…" : retryIn > 0 ? `Run (${retryIn}s)` : "Run";
  const lastEnd = run.phase === "idle" ? run.last : undefined;
  const runDisabled = isViewer || running || retryIn > 0;

  const runButton = (
    <Button size="sm" variant="success" onClick={startRun} disabled={runDisabled} title={isViewer ? VIEWER_REASON : undefined} data-testid="run-button">
      {running ? <Spinner /> : <Play className="fill-current" />}
      {runLabel}
    </Button>
  );
  const aiButton = (
    <Button
      size="sm"
      variant={aiOpen ? "default" : "outline"}
      onClick={() => setAiOpen((o) => !o)}
      disabled={isViewer}
      title={isViewer ? VIEWER_REASON : undefined}
      aria-pressed={aiOpen}
      data-testid="ai-button"
    >
      <Sparkles /> AI fix
    </Button>
  );

  return (
    <div className="flex h-[calc(100vh-var(--topbar-h))] min-h-0 flex-col max-lg:h-auto max-lg:min-h-[calc(100vh-var(--topbar-h))]" data-testid="room" data-role={room.myRole ?? ""}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link href="/rooms" className="text-muted-foreground hover:text-foreground" aria-label="Back to rooms"><ArrowLeft className="size-4" /></Link>
          <h1 className="truncate text-base font-semibold" data-testid="room-title">{room.title}</h1>
          <Badge variant="outline" className="font-mono">{fileNameFor(room.language)}</Badge>
          <Badge variant="outline">{languageLabel(room.language)}</Badge>
          <Badge variant={room.myRole === "OWNER" ? "accent" : room.myRole === "VIEWER" ? "warning" : "secondary"} data-testid="my-role">
            {roleLabel(room.myRole)}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PresenceAvatars provider={provider} selfId={user!.id} />
          <ConnectionPill state={conn} />
          <Separator orientation="vertical" className="mx-1 h-6" />
          <CopyInvite roomId={roomId} />
          {isViewer ? <Hint label={VIEWER_REASON} wrap>{aiButton}</Hint> : aiButton}
          {isViewer ? <Hint label={VIEWER_REASON} wrap>{runButton}</Hint> : <Hint label={`Run ${fileNameFor(room.language)} in the sandbox`}>{runButton}</Hint>}
        </div>
      </header>

      {isViewer && (
        <div className="flex items-center gap-2 border-b bg-warning/10 px-4 py-2 text-[13px] text-warning" role="note" data-testid="viewer-banner">
          <Eye className="size-4 shrink-0" /> {VIEWER_REASON}
        </div>
      )}

      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_240px] [grid-template-areas:'editor'_'output']",
          aiOpen && "lg:grid-cols-[minmax(0,1fr)_380px] lg:[grid-template-areas:'editor_aside'_'output_aside']",
          "max-lg:grid-rows-[60vh_auto_260px] max-lg:[grid-template-areas:'editor'_'aside'_'output']"
        )}
      >
        <div className="relative min-h-0 bg-card [grid-area:editor]" ref={setDiffHost} data-testid="editor-area">
          <Editor
            roomId={roomId}
            language={room.language}
            syncUrl={syncOverride}
            getToken={getToken}
            user={presenceUser}
            readOnly={isViewer}
            theme={scheme}
            height="100%"
            onReady={onReady}
            onProvider={setProvider}
            onStatus={setConn}
          />
        </div>

        {aiOpen && (
          <aside className="min-h-0 border-l bg-card [grid-area:aside] max-lg:border-l-0 max-lg:border-t">
            <AIDiffPanel
              roomId={roomId}
              language={room.language}
              getCode={() => getCodeRef.current()}
              getToken={getToken}
              disabledReason={isViewer ? VIEWER_REASON : null}
              diffHost={diffHost}
              theme={scheme}
              onClose={() => setAiOpen(false)}
            />
          </aside>
        )}

        <section className="flex min-h-0 flex-col border-t bg-card [grid-area:output]" aria-label="Run output">
          <div className="flex flex-wrap items-center gap-3 border-b px-3 py-1.5 text-[13px]">
            <span className="inline-flex items-center gap-1.5 font-medium"><TerminalSquare className="size-4 text-muted-foreground" />Output</span>
            <span
              data-testid="run-status"
              className={cn(
                "text-muted-foreground",
                lastEnd && (lastEnd.code === 0 ? "text-success" : "text-destructive")
              )}
            >
              {run.phase === "starting" && "Queuing your run…"}
              {run.phase === "running" && `Running ${fileNameFor(room.language)}…`}
              {lastEnd && (lastEnd.code === 0
                ? "Finished: exit code 0"
                : lastEnd.status === "timeout"
                ? "Stopped: time limit reached"
                : lastEnd.status === "disconnected"
                ? "Lost the output stream"
                : `Failed: exit code ${lastEnd.code ?? "?"}`)}
              {run.phase === "idle" && !lastEnd && !runError && `Run ${fileNameFor(room.language)} to see its output here.`}
            </span>
            {runError && (
              <span className="inline-flex items-center gap-1.5 font-medium text-destructive" role="alert" data-testid="run-error">
                <AlertCircle className="size-4" />
                {runError}{retryIn > 0 && !/Try again in/.test(runError) ? ` (${retryIn}s)` : ""}
              </span>
            )}
          </div>
          <Terminal roomId={roomId} jobId={jobId} getToken={getToken} syncUrl={syncOverride} theme={scheme} onEnd={onEnd} />
        </section>
      </div>
    </div>
  );
}
