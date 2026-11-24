import { useEffect, useState } from "react";
import type { WebsocketProvider } from "y-websocket";
import { Check, Link2 } from "lucide-react";
import { toast } from "sonner";
import type { ConnState } from "./Editor";
import { initials } from "../lib/util";
import { cn } from "../lib/utils";
import { Avatar } from "./ui/display";
import { Button } from "./ui/button";
import { Hint } from "./ui/overlay";

type Person = { userId: string; name: string; color: string; self: boolean };

/** Everyone in the room right now, from Yjs awareness (one avatar per user, not per tab). */
export function PresenceAvatars({ provider, selfId }: { provider: WebsocketProvider | null; selfId: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    if (!provider) return;
    const update = () => {
      const byUser = new Map<string, Person>();
      provider.awareness.getStates().forEach((state: any) => {
        const u = state?.user;
        if (!u?.userId || byUser.has(u.userId)) return;
        byUser.set(u.userId, { userId: u.userId, name: String(u.name ?? "Anonymous"), color: u.color, self: u.userId === selfId });
      });
      setPeople([...byUser.values()].sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name)));
    };
    update();
    provider.awareness.on("change", update);
    return () => provider.awareness.off("change", update);
  }, [provider, selfId]);

  const shown = people.slice(0, 5);
  const extra = people.length - shown.length;
  return (
    <div className="flex items-center -space-x-2 pr-1" aria-label={`${people.length} ${people.length === 1 ? "person" : "people"} in this room`} data-testid="presence">
      {shown.map((p) => (
        <Hint key={p.userId} label={p.self ? `${p.name} (you)` : p.name}>
          <Avatar color={p.color} title={p.self ? `${p.name} (you)` : p.name} data-testid="avatar" data-user-id={p.userId} data-name={p.name}>
            {initials(p.name)}
          </Avatar>
        </Hint>
      ))}
      {extra > 0 && (
        <Avatar color="hsl(var(--muted))" className="text-muted-foreground" title={people.slice(5).map((p) => p.name).join(", ")}>
          +{extra}
        </Avatar>
      )}
    </div>
  );
}

const PILL: Record<ConnState, { label: string; title: string; cls: string; dot: string }> = {
  connecting: { label: "Connecting", title: "Connecting to the room…", cls: "bg-muted text-muted-foreground", dot: "bg-muted-foreground animate-pulse" },
  connected: { label: "Connected", title: "Live: your edits are shared as you type.", cls: "bg-success/15 text-success", dot: "bg-success" },
  reconnecting: { label: "Reconnecting", title: "Connection lost. Your edits are kept and will sync when it's back.", cls: "bg-warning/15 text-warning", dot: "bg-warning animate-pulse" },
  offline: { label: "Offline", title: "You're offline. Keep editing; changes sync when you reconnect.", cls: "bg-destructive/15 text-destructive", dot: "bg-destructive" },
};

export function ConnectionPill({ state }: { state: ConnState }) {
  const p = PILL[state];
  return (
    <Hint label={p.title}>
      <span
        className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium", p.cls)}
        data-testid="conn-pill"
        data-state={state}
        role="status"
      >
        <span className={cn("size-1.5 rounded-full", p.dot)} aria-hidden="true" />
        {p.label}
      </span>
    </Hint>
  );
}

export function CopyInvite({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const link = `${window.location.origin}/room/${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Invite link copied", { description: "Anyone with the link (and passcode, if set) can join." });
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast("Copy this invite link", { description: link, duration: 15000 });
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} data-testid="copy-invite">
      {copied ? <Check /> : <Link2 />}
      {copied ? "Copied" : "Invite"}
    </Button>
  );
}
