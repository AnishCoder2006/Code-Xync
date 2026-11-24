import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronRight, FolderOpen, KeyRound, RefreshCw, Users } from "lucide-react";
import { api, describeError, languageLabel, roleLabel, type RoomSummary } from "../../lib/api";
import { useRequireAuth } from "../../lib/useRequireAuth";
import { timeAgo } from "../../lib/util";
import { CreateRoomForm } from "../../components/CreateRoomForm";
import { JoinRoomForm } from "../../components/JoinRoomForm";
import { Button } from "../../components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "../../components/ui/display";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/overlay";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; rooms: RoomSummary[] };

const LANG_DOT: Record<string, string> = { python: "bg-[#3776ab]", javascript: "bg-[#e5b400]" };

export default function Dashboard() {
  const auth = useRequireAuth();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const { getToken, isSignedIn, user } = auth;

  const fetchRooms = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const { rooms } = await api<{ rooms: RoomSummary[] }>(getToken, "/rooms");
      setLoad({ state: "ready", rooms });
    } catch (err) {
      setLoad({ state: "error", message: describeError(err) });
    }
  }, [getToken]);

  useEffect(() => {
    if (isSignedIn) fetchRooms();
  }, [isSignedIn, fetchRooms]);

  const goToRoom = (id: string) => router.push(`/room/${encodeURIComponent(id)}`);

  if (!auth.isLoaded || !auth.isSignedIn) return null;

  return (
    <div className="container py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          {user?.name ? `Welcome back, ${user.name.split(" ")[0]}` : "Your rooms"}
        </h1>
        <p className="mt-1 text-muted-foreground">Rooms you own or have joined. Open one to edit, run and fix code together.</p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-label="Rooms" className="order-2 min-w-0 lg:order-1">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              Your rooms{load.state === "ready" ? ` · ${load.rooms.length}` : ""}
            </h2>
            <Button variant="ghost" size="sm" onClick={fetchRooms} disabled={load.state === "loading"} aria-label="Refresh rooms">
              <RefreshCw className={load.state === "loading" ? "animate-spin" : ""} /> Refresh
            </Button>
          </div>

          {load.state === "loading" && (
            <div className="grid gap-3" aria-busy="true" data-testid="rooms-loading">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)}
            </div>
          )}

          {load.state === "error" && (
            <Alert variant="destructive" data-testid="rooms-error">
              <AlertCircle />
              <div className="grid gap-2">
                <span>{load.message}</span>
                <Button size="sm" variant="outline" className="w-fit" onClick={fetchRooms}>Try again</Button>
              </div>
            </Alert>
          )}

          {load.state === "ready" && load.rooms.length === 0 && (
            <Card className="flex flex-col items-center gap-3 border-dashed bg-card/70 px-6 py-14 text-center backdrop-blur" data-testid="rooms-empty">
              <span className="inline-flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <FolderOpen className="size-5" />
              </span>
              <h3 className="text-base font-semibold">No rooms yet</h3>
              <p className="max-w-sm text-muted-foreground">Create a room, or paste an invite link someone sent you.</p>
            </Card>
          )}

          {load.state === "ready" && load.rooms.length > 0 && (
            <ul className="grid gap-3" data-testid="room-list">
              {load.rooms.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/room/${encodeURIComponent(r.id)}`}
                    data-testid="room-card"
                    data-room-id={r.id}
                    className="group flex items-center gap-4 rounded-xl border bg-card/90 px-4 py-3.5 shadow-sm backdrop-blur transition-all hover:-translate-y-px hover:border-primary/40 hover:shadow-md"
                  >
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs font-semibold text-muted-foreground">
                      {r.language === "python" ? ".py" : ".js"}
                    </span>
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate font-medium">{r.title}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Updated {timeAgo(r.lastUpdatedAt)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1"><Users className="size-3" />{r.memberCount} {r.memberCount === 1 ? "member" : "members"}</span>
                      </span>
                    </div>
                    <div className="hidden flex-wrap items-center justify-end gap-1.5 sm:flex">
                      <Badge variant="outline"><span className={`size-1.5 rounded-full ${LANG_DOT[r.language] ?? "bg-muted-foreground"}`} />{languageLabel(r.language)}</Badge>
                      {r.hasPasscode && <Badge variant="outline" title="Joining needs a passcode"><KeyRound className="size-3" />Passcode</Badge>}
                      <Badge variant={r.role === "OWNER" ? "accent" : "secondary"} data-testid="room-role">{roleLabel(r.role)}</Badge>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Card className="order-1 bg-card/90 backdrop-blur lg:sticky lg:top-[calc(var(--topbar-h)+1.5rem)] lg:order-2">
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Start collaborating</CardTitle>
            <CardDescription>Create a new room or join one with an invite.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="create">
              <TabsList>
                <TabsTrigger value="create">New room</TabsTrigger>
                <TabsTrigger value="join">Join a room</TabsTrigger>
              </TabsList>
              <TabsContent value="create">
                <CreateRoomForm getToken={getToken} onCreated={goToRoom} />
              </TabsContent>
              <TabsContent value="join">
                <JoinRoomForm getToken={getToken} onJoined={goToRoom} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
