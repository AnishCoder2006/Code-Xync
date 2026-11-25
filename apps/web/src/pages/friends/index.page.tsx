import { useRouter } from "next/router";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle, Check, Copy, Link2, MessageSquareShare, Play, RefreshCw, Rocket, Sparkles, UserMinus, UserPlus, Users, X,
} from "lucide-react";
import { toast } from "sonner";
import { api, describeError, friendLink, type Friend, type FriendsData, type RoomDetail } from "../../lib/api";
import { useRequireAuth } from "../../lib/useRequireAuth";
import { colorFor, initials, timeAgo } from "../../lib/util";
import { Button } from "../../components/ui/button";
import { Alert, Avatar, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "../../components/ui/display";
import { Input } from "../../components/ui/form";

const roomsWord = (n: number) => `${n} shared ${n === 1 ? "room" : "rooms"}`;

function Person({ id, name, sub }: { id: string; name: string; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar color={colorFor(id)}>{initials(name)}</Avatar>
      <div className="grid min-w-0">
        <span className="truncate text-sm font-medium">{name}</span>
        {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}

function InviteCard({ code }: { code: string }) {
  const link = friendLink(code);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Invite link copied", { description: "Send it to a friend. When they open it, you're connected." });
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy. Select the link and copy it yourself.");
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: "Code with me on codexync", text: "Add me as a friend on codexync and let's code together:", url: link });
    } catch {
      /* closed the share sheet */
    }
  };
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <Card className="bg-card/90 backdrop-blur" data-testid="invite-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><Link2 className="size-4 text-brand" />Your invite link</CardTitle>
        <CardDescription>Anyone who opens it and taps Accept becomes your friend straight away.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex gap-2">
          <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[13px]" aria-label="Your invite link" data-testid="invite-link" />
          <Button variant="brand" onClick={copy} className="shrink-0" data-testid="copy-invite">
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Friend code</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground" data-testid="friend-code">{code}</code>
          {canShare && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={share}><MessageSquareShare />Share…</Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function FriendsPage() {
  const auth = useRequireAuth();
  const { getToken, isSignedIn } = auth;
  const router = useRouter();
  const [data, setData] = useState<FriendsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<FriendsData>(getToken, "/friends"));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (isSignedIn) load();
  }, [isSignedIn, load]);

  /** Runs one action with a per-item spinner, then reloads the page data. */
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await load();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setAddError(null);
    setBusy("add");
    try {
      const body = q.includes("@") && !q.includes("/") ? { email: q } : { code: q };
      const r = await api<{ outcome: string; user: { name: string } }>(getToken, "/friends/requests", { body });
      toast.success(
        r.outcome === "accepted" ? `You and ${r.user.name} are now friends` :
        r.outcome === "already-requested" ? `Already waiting for ${r.user.name} to accept` :
        `Request sent to ${r.user.name}`
      );
      setQuery("");
      await load();
    } catch (err) {
      setAddError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const startRoom = (f: Friend) =>
    act(`room:${f.id}`, async () => {
      const me = auth.user?.name?.split(" ")[0] ?? "Me";
      const room = await api<RoomDetail>(getToken, "/rooms", { body: { title: `${me} & ${f.name.split(" ")[0]}`, language: "python" } });
      await api(getToken, `/rooms/${encodeURIComponent(room.id)}/members`, { body: { userId: f.id } });
      toast.success(`Room ready. ${f.name} can open it from their Rooms page.`);
      router.push(`/room/${encodeURIComponent(room.id)}`);
    });

  const unfriend = (f: Friend) => {
    if (!window.confirm(`Remove ${f.name} from your friends? You'll both stay in any rooms you share.`)) return;
    act(`unfriend:${f.id}`, () => api(getToken, `/friends/${encodeURIComponent(f.id)}`, { method: "DELETE" }), `${f.name} removed`);
  };

  if (!auth.isLoaded || !auth.isSignedIn) return null;

  return (
    <div className="container py-10" data-testid="friends-page">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Friends</h1>
          <p className="mt-1 text-muted-foreground">Invite the people you code with, then pull them into a room in one click.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      {error && <Alert variant="destructive" className="mb-6"><AlertCircle /><span>{error}</span></Alert>}

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {data ? <InviteCard code={data.me.friendCode} /> : <Skeleton className="h-[168px] rounded-xl" />}
        <Card className="bg-card/90 backdrop-blur">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><UserPlus className="size-4 text-brand" />Add a friend</CardTitle>
            <CardDescription>Paste their friend code or invite link, or type the email they signed up with.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={add} className="grid gap-2">
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="raj-patel-7k3qm2 or raj@example.com"
                  aria-label="Friend code, invite link or email"
                  data-testid="add-friend-input"
                />
                <Button type="submit" disabled={!query.trim() || busy === "add"} className="shrink-0" data-testid="add-friend">
                  <UserPlus /> Add
                </Button>
              </div>
              {addError && <p className="text-sm text-destructive" role="alert">{addError}</p>}
            </form>
          </CardContent>
        </Card>
      </div>

      {data && data.incoming.length > 0 && (
        <section className="mb-8" data-testid="incoming-requests">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Requests <Badge variant="accent">{data.incoming.length}</Badge>
          </h2>
          <div className="grid gap-2 md:grid-cols-2">
            {data.incoming.map((r) => (
              <Card key={r.id} className="flex items-center justify-between gap-3 bg-card/90 p-3 backdrop-blur">
                <Person id={r.user.id} name={r.user.name} sub={`Asked ${timeAgo(r.createdAt)}${r.sharedRooms ? ` · ${roomsWord(r.sharedRooms)}` : ""}`} />
                <div className="flex shrink-0 gap-1.5">
                  <Button size="sm" variant="brand" disabled={busy === r.id}
                    onClick={() => act(r.id, () => api(getToken, `/friends/requests/${r.id}/accept`, { method: "POST" }), `You and ${r.user.name} are now friends`)}>
                    <Check /> Accept
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Decline ${r.user.name}`} disabled={busy === r.id}
                    onClick={() => act(r.id, () => api(getToken, `/friends/requests/${r.id}`, { method: "DELETE" }))}>
                    <X />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your friends {data && <Badge variant="secondary">{data.friends.length}</Badge>}
        </h2>
        {!data ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[132px] rounded-xl" />)}</div>
        ) : data.friends.length === 0 ? (
          <Card className="grid place-items-center gap-2 bg-card/90 px-6 py-12 text-center backdrop-blur">
            <Users className="size-8 text-muted-foreground" />
            <p className="font-medium">No friends yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Copy your invite link above and send it to someone you code with. They'll show up here once they accept.</p>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="friend-list">
            {data.friends.map((f) => (
              <Card key={f.id} className="group grid gap-4 bg-card/90 p-4 backdrop-blur transition-colors hover:border-foreground/20" data-testid="friend" data-user-id={f.id}>
                <div className="flex items-start justify-between gap-2">
                  <Person id={f.id} name={f.name} sub={`Friends since ${timeAgo(f.since)}`} />
                  <Button variant="ghost" size="icon" className="opacity-60 group-hover:opacity-100" aria-label={`Remove ${f.name}`}
                    disabled={busy === `unfriend:${f.id}`} onClick={() => unfriend(f)}>
                    <UserMinus />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Users className="size-3.5" />{roomsWord(f.sharedRooms)}</span>
                  <span className="inline-flex items-center gap-1"><Play className="size-3.5" />{f.lastRunAt ? `Ran code ${timeAgo(f.lastRunAt)}` : "Hasn't run code yet"}</span>
                </div>
                <Button variant="outline" size="sm" disabled={busy === `room:${f.id}`} onClick={() => startRoom(f)} data-testid="start-room-with">
                  <Rocket /> Start a room together
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      {data && data.suggestions.length > 0 && (
        <section className="mb-8" data-testid="suggestions">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Sparkles className="size-4 text-brand" />People you've coded with
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">You share rooms with them but aren't friends yet.</p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.suggestions.map((s) => (
              <Card key={s.id} className="flex items-center justify-between gap-3 bg-card/90 p-3 backdrop-blur">
                <Person id={s.id} name={s.name} sub={roomsWord(s.sharedRooms)} />
                <Button size="sm" variant="outline" disabled={busy === s.id}
                  onClick={() => act(s.id, () => api(getToken, "/friends/requests", { body: { userId: s.id } }), `Request sent to ${s.name}`)}>
                  <UserPlus /> Add
                </Button>
              </Card>
            ))}
          </div>
        </section>
      )}

      {data && data.outgoing.length > 0 && (
        <section data-testid="outgoing-requests">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Waiting for them</h2>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.outgoing.map((r) => (
              <Card key={r.id} className="flex items-center justify-between gap-3 bg-card/90 p-3 backdrop-blur">
                <Person id={r.user.id} name={r.user.name} sub={`Sent ${timeAgo(r.createdAt)}`} />
                <Button size="sm" variant="ghost" disabled={busy === r.id}
                  onClick={() => act(r.id, () => api(getToken, `/friends/requests/${r.id}`, { method: "DELETE" }), "Request cancelled")}>
                  Cancel
                </Button>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
