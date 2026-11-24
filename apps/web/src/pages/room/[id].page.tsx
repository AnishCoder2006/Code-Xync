import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WebsocketProvider } from "y-websocket";
import { AlertCircle, ArrowLeft, Eye, History, Play, Search, Settings, Sparkles, TerminalSquare, Users, X } from "lucide-react";
import { ApiError, api, describeError, fileNameFor, languageLabel, roleLabel, type RoomDetail } from "../../lib/api";
import { useSyncUrlOverride } from "../../lib/auth";
import { useRequireAuth } from "../../lib/useRequireAuth";
import { colorFor, useColorScheme, useCountdown } from "../../lib/util";
import { cn } from "../../lib/utils";
import { languageInfo } from "../../lib/languages";
import type { ConnState, EditorHelpers } from "../../components/Editor";
import { SearchPanel } from "../../components/SearchPanel";
import { HistoryPanel } from "../../components/HistoryPanel";
import { PeoplePanel } from "../../components/PeoplePanel";
import { SettingsPanel } from "../../components/SettingsPanel";
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

type Panel = "ai" | "search" | "history" | "people" | "settings";
const PANELS: { id: Panel; label: string; icon: typeof Sparkles }[] = [
  { id: "ai", label: "AI fix", icon: Sparkles },
  { id: "search", label: "Search", icon: Search },
  { id: "history", label: "History", icon: History },
  { id: "people", label: "People", icon: Users },
  { id: "settings", label: "Settings", icon: Settings },
];

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
  const [panel, setPanel] = useState<Panel | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [diffHost, setDiffHost] = useState<HTMLDivElement | null>(null);
  const getCodeRef = useRef<() => string>(() => "");
  const revealRef = useRef<EditorHelpers["reveal"]>(() => {});
  const retryIn = useCountdown(retryAt);

  /** silent: refresh in place (no loading screen, editor stays mounted). */
  const fetchRoom = useCallback(
    async (silent = false) => {
      if (!roomId) return;
      if (!silent) setLoad({ state: "loading" });
      try {
        const room = await api<RoomDetail>(getToken, `/rooms/${encodeURIComponent(roomId)}`);
        setLoad({ state: "ready", room });
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) setLoad({ state: "forbidden" });
        else if (!silent) setLoad({ state: "error", message: describeError(err) });
      }
    },
    [roomId, getToken]
  );

  useEffect(() => {
    if (auth.isSignedIn && roomId) fetchRoom();
  }, [auth.isSignedIn, roomId, fetchRoom]);

  // A role change by the owner closes our socket; when it reconnects, re-read our role.
  const prevConn = useRef<ConnState>("connecting");
  useEffect(() => {
    if (conn === "connected" && prevConn.current === "reconnecting") fetchRoom(true);
    prevConn.current = conn;
  }, [conn, fetchRoom]);

  const onReady = useCallback((helpers: EditorHelpers) => {
    getCodeRef.current = helpers.getCode;
    revealRef.current = helpers.reveal;
  }, []);
  const onEnd = useCallback((end: RunEnd) => {
    setRun({ phase: "idle", last: end });
    setHistoryKey((k) => k + 1);
  }, []);
  const openPanel = (p: Panel) => {
    setPanel((cur) => (cur === p ? null : p));
    if (p === "history") setHistoryKey((k) => k + 1);
  };

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
            <Button size="sm" variant="outline" className="w-fit" onClick={() => fetchRoom()}>Try again</Button>
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
            <JoinRoomForm getToken={getToken} roomId={roomId} onJoined={() => fetchRoom()} />
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
  const lang = languageInfo(room.language);
  const runBlockedReason = isViewer
    ? VIEWER_REASON
    : !lang.run
    ? `Running ${lang.label} is not available yet. You can still edit together.`
    : null;
  const aiBlockedReason = isViewer
    ? VIEWER_REASON
    : !lang.run
    ? `AI fixes are not available for ${lang.label} yet (fixes are tested by running them).`
    : null;
  const running = run.phase !== "idle";

  const startRun = async () => {
    if (runBlockedReason || running || retryIn > 0) return;
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
  const runDisabled = !!runBlockedReason || running || retryIn > 0;

  const runButton = (
    <Button size="sm" variant="brand" onClick={startRun} disabled={runDisabled} title={runBlockedReason ?? undefined} data-testid="run-button">
      {running ? <Spinner /> : <Play className="fill-current" />}
      {runLabel}
    </Button>
  );
  const aiButton = (
    <Button
      size="sm"
      variant={panel === "ai" ? "default" : "outline"}
      onClick={() => openPanel("ai")}
      disabled={!!aiBlockedReason}
      title={aiBlockedReason ?? undefined}
      aria-pressed={panel === "ai"}
      data-testid="ai-button"
    >
      <Sparkles /> AI fix
    </Button>
  );
  const toolButtons = (
    <div className="inline-flex rounded-md border bg-muted/40 p-0.5" role="group" aria-label="Room tools">
      {PANELS.filter((p) => p.id !== "ai").map(({ id, label, icon: Icon }) => (
        <Hint key={id} label={id === "search" ? "Search the code in this room" : id === "history" ? "Runs and AI fixes in this room" : id === "people" ? "Members, roles and who's online" : "Name, language, passcode, delete"}>
          <Button
            size="sm"
            variant={panel === id ? "secondary" : "ghost"}
            className={cn("h-7 px-2.5", panel === id && "bg-card shadow-sm")}
            onClick={() => openPanel(id)}
            aria-pressed={panel === id}
            data-testid={`${id}-button`}
          >
            <Icon /> <span className={cn("max-sm:sr-only", id === "settings" && "sr-only")}>{label}</span>
          </Button>
        </Hint>
      ))}
    </div>
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
          {toolButtons}
          <CopyInvite roomId={roomId} />
          {aiBlockedReason ? <Hint label={aiBlockedReason} wrap>{aiButton}</Hint> : aiButton}
          {runBlockedReason ? <Hint label={runBlockedReason} wrap>{runButton}</Hint> : <Hint label={`Run ${fileNameFor(room.language)} in the sandbox`}>{runButton}</Hint>}
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
          panel && "lg:grid-cols-[minmax(0,1fr)_400px] lg:[grid-template-areas:'editor_aside'_'output_aside']",
          "max-lg:grid-rows-[60vh_auto_260px] max-lg:[grid-template-areas:'editor'_'aside'_'output']"
        )}
      >
        <div className="relative min-h-0 bg-card [grid-area:editor]" ref={setDiffHost} data-testid="editor-area">
          <Editor
            roomId={roomId}
            language={lang.monaco}
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

        {panel && (
          <aside className="flex min-h-0 flex-col border-l bg-card [grid-area:aside] max-lg:border-l-0 max-lg:border-t" data-testid="side-panel">
            <div className="flex items-center gap-1 border-b px-2 py-1.5" role="tablist" aria-label="Room tools">
              {PANELS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={panel === id}
                  onClick={() => setPanel(id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                    panel === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  data-testid={`tab-${id}`}
                >
                  <Icon className="size-4" /> <span className={cn(id === "settings" && "sr-only")}>{label}</span>
                </button>
              ))}
              <Button variant="ghost" size="icon" className="ml-auto" onClick={() => setPanel(null)} aria-label="Close panel">
                <X />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              {/* Every tab stays mounted while the panel is open, so a pending AI diff survives tab switches. */}
              <div className={cn("h-full", panel !== "ai" && "hidden")}>
                <AIDiffPanel
                  roomId={roomId}
                  language={room.language}
                  getCode={() => getCodeRef.current()}
                  getToken={getToken}
                  disabledReason={aiBlockedReason}
                  diffHost={diffHost}
                  theme={scheme}
                  onClose={() => setPanel(null)}
                  embedded
                />
              </div>
              <div className={cn("h-full", panel !== "search" && "hidden")}>
                <SearchPanel roomId={roomId} getToken={getToken} onReveal={(s, e) => revealRef.current(s, e)} />
              </div>
              <div className={cn("h-full", panel !== "history" && "hidden")}>
                <HistoryPanel roomId={roomId} getToken={getToken} refreshKey={historyKey} />
              </div>
              <div className={cn("h-full", panel !== "people" && "hidden")}>
                <PeoplePanel
                  room={room}
                  selfId={user!.id}
                  provider={provider}
                  getToken={getToken}
                  onChanged={() => fetchRoom(true)}
                  onLeft={() => router.push("/rooms")}
                />
              </div>
              <div className={cn("h-full", panel !== "settings" && "hidden")}>
                <SettingsPanel room={room} getToken={getToken} onSaved={() => fetchRoom(true)} onDeleted={() => router.push("/rooms")} />
              </div>
            </div>
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
              {run.phase === "idle" && !lastEnd && !runError &&
                (lang.run ? `Run ${fileNameFor(room.language)} to see its output here.` : `Running ${lang.label} is not available yet; this room is for editing together.`)}
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
