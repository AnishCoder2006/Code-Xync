/**
 * People (Phase 1, roles): who is in the room, who is online right now, and — for the
 * owner — changing roles or removing members. Changes take effect live: sync nodes drop
 * the member's sockets and their reconnect is checked against the new role.
 */
import { useEffect, useState } from "react";
import type { WebsocketProvider } from "y-websocket";
import Link from "next/link";
import { AlertCircle, Crown, LogOut, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { api, describeError, roleLabel, type Friend, type FriendsData, type GetToken, type RoomDetail } from "../lib/api";
import { colorFor, initials, timeAgo } from "../lib/util";
import { Button } from "./ui/button";
import { Alert, Avatar, Badge } from "./ui/display";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/overlay";

type Props = {
  room: RoomDetail;
  selfId: string;
  provider: WebsocketProvider | null;
  getToken: GetToken;
  onChanged: () => void;
  onLeft: () => void;
};

function useOnlineIds(provider: WebsocketProvider | null) {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!provider) return;
    const update = () => {
      const s = new Set<string>();
      provider.awareness.getStates().forEach((st: any) => st?.user?.userId && s.add(st.user.userId));
      setIds(s);
    };
    update();
    provider.awareness.on("change", update);
    return () => provider.awareness.off("change", update);
  }, [provider]);
  return ids;
}

/** Friends who aren't in this room yet, each one click away from joining it. */
function InviteFriends({ room, getToken, onAdded }: { room: RoomDetail; getToken: GetToken; onAdded: () => void }) {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    api<FriendsData>(getToken, "/friends")
      .then((d) => live && setFriends(d.friends))
      .catch(() => live && setFriends([]));
    return () => {
      live = false;
    };
  }, [getToken]);

  const invite = async (f: Friend) => {
    setBusy(f.id);
    try {
      await api(getToken, `/rooms/${encodeURIComponent(room.id)}/members`, { body: { userId: f.id, role: "EDITOR" } });
      setAdded((s) => new Set(s).add(f.id));
      toast.success(`${f.name} added as an editor`, { description: "The room is now on their Rooms page." });
      onAdded();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  if (!friends) return null;
  const memberIds = new Set(room.members.map((m) => m.userId));
  const outside = friends.filter((f) => !memberIds.has(f.id) && !added.has(f.id));

  return (
    <section className="grid gap-2" data-testid="invite-friends">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold"><UserPlus className="size-4 text-brand" />Invite friends</h3>
      {friends.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No friends yet. <Link href="/friends" className="font-medium text-foreground underline-offset-4 hover:underline">Share your invite link</Link> to add some.
        </p>
      ) : outside.length === 0 ? (
        <p className="text-sm text-muted-foreground">All your friends are already here.</p>
      ) : (
        <ul className="grid gap-1.5">
          {outside.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2" data-testid="invite-friend">
              <Avatar color={colorFor(f.id)}>{initials(f.name)}</Avatar>
              <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
              <Button size="sm" variant="outline" disabled={busy === f.id} onClick={() => invite(f)} aria-label={`Add ${f.name} to this room`}>
                <UserPlus /> Add
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PeoplePanel({ room, selfId, provider, getToken, onChanged, onLeft }: Props) {
  const online = useOnlineIds(provider);
  const isOwner = room.myRole === "OWNER";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setRole = async (userId: string, role: "EDITOR" | "VIEWER") => {
    setBusy(userId);
    setError(null);
    try {
      await api(getToken, `/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: { role } });
      toast.success(`Role changed to ${roleLabel(role)}`, { description: "It applies immediately, including to their open editor." });
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (userId: string, name: string) => {
    const self = userId === selfId;
    if (!window.confirm(self ? "Leave this room? You'll need the link (and passcode) to come back." : `Remove ${name} from this room?`)) return;
    setBusy(userId);
    setError(null);
    try {
      await api(getToken, `/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
      if (self) onLeft();
      else {
        toast.success(`${name} was removed`);
        onChanged();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const members = [...room.members].sort((a, b) => {
    const order = { OWNER: 0, EDITOR: 1, VIEWER: 2 } as const;
    return order[a.role] - order[b.role] || (a.name ?? "").localeCompare(b.name ?? "");
  });

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-testid="people-panel">
      <div>
        <h2 className="text-[15px] font-semibold">People</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {members.length} {members.length === 1 ? "member" : "members"} · {[...online].filter((id) => members.some((m) => m.userId === id)).length} online now.
          {isOwner ? " As the owner you can change roles." : ""}
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center text-xs">
        {(["OWNER", "EDITOR", "VIEWER"] as const).map((r) => (
          <div key={r} className="rounded-lg border bg-muted/40 px-2 py-2">
            <dt className="font-semibold text-foreground">{roleLabel(r)}</dt>
            <dd className="mt-0.5 text-muted-foreground">
              {r === "OWNER" ? "Full control" : r === "EDITOR" ? "Edit, run, AI" : "Read only"}
            </dd>
          </div>
        ))}
      </dl>

      {error && <Alert variant="destructive"><AlertCircle /><span>{error}</span></Alert>}

      <ul className="grid gap-2" data-testid="member-list">
        {members.map((m) => {
          const name = m.name ?? m.userId;
          const isSelf = m.userId === selfId;
          const isOnline = online.has(m.userId);
          return (
            <li key={m.userId} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5" data-testid="member" data-user-id={m.userId} data-role={m.role}>
              <span className="relative">
                <Avatar color={colorFor(m.userId)}>{initials(name)}</Avatar>
                <span
                  className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card ${isOnline ? "bg-success" : "bg-muted-foreground/40"}`}
                  title={isOnline ? "Online now" : "Offline"}
                  aria-label={isOnline ? "online" : "offline"}
                />
              </span>
              <div className="grid min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{name}{isSelf ? " (you)" : ""}</span>
                <span className="text-xs text-muted-foreground">Joined {timeAgo(m.joinedAt)}</span>
              </div>
              {m.role === "OWNER" ? (
                <Badge variant="accent"><Crown className="size-3" />Owner</Badge>
              ) : isOwner ? (
                <div className="flex items-center gap-1">
                  <Select value={m.role} onValueChange={(v) => setRole(m.userId, v as "EDITOR" | "VIEWER")} disabled={busy === m.userId}>
                    <SelectTrigger className="h-8 w-[104px]" aria-label={`Role for ${name}`} data-testid="member-role-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="EDITOR">Editor</SelectItem>
                      <SelectItem value="VIEWER">Viewer</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="icon" onClick={() => remove(m.userId, name)} disabled={busy === m.userId} aria-label={`Remove ${name}`}>
                    <UserMinus />
                  </Button>
                </div>
              ) : (
                <Badge variant={m.role === "VIEWER" ? "warning" : "secondary"}>{roleLabel(m.role)}</Badge>
              )}
            </li>
          );
        })}
      </ul>

      {room.myRole !== "VIEWER" && <InviteFriends room={room} getToken={getToken} onAdded={onChanged} />}

      {!isOwner && (
        <Button variant="outline" className="mt-auto" onClick={() => remove(selfId, "you")} disabled={busy === selfId} data-testid="leave-room">
          <LogOut /> Leave this room
        </Button>
      )}
    </div>
  );
}
