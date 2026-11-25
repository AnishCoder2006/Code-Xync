import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ArrowRight, Check, UserPlus } from "lucide-react";
import { api, describeError, type FriendLinkPreview } from "../../../lib/api";
import { useRequireAuth } from "../../../lib/useRequireAuth";
import { colorFor, initials } from "../../../lib/util";
import { Button } from "../../../components/ui/button";
import { Alert, Avatar, Card, Skeleton } from "../../../components/ui/display";

/** Landing page for a friend's invite link: who invited you, and one button to accept. */
export default function AcceptInvitePage() {
  const auth = useRequireAuth();
  const router = useRouter();
  const code = typeof router.query.code === "string" ? router.query.code : "";
  const [preview, setPreview] = useState<FriendLinkPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!code) return;
    try {
      setPreview(await api<FriendLinkPreview>(auth.getToken, `/friends/link/${encodeURIComponent(code)}`));
    } catch (err) {
      setError(describeError(err));
    }
  }, [auth.getToken, code]);

  useEffect(() => {
    if (auth.isSignedIn) load();
  }, [auth.isSignedIn, load]);

  const accept = async () => {
    setBusy(true);
    try {
      await api(auth.getToken, `/friends/link/${encodeURIComponent(code)}`, { method: "POST" });
      setPreview((p) => (p ? { ...p, status: "friends" } : p));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!auth.isLoaded || !auth.isSignedIn) return null;
  const name = preview?.user.name ?? "";

  return (
    <div className="container grid min-h-[70vh] place-items-center py-10" data-testid="friend-invite-page">
      <Card className="w-full max-w-md bg-card/90 p-8 text-center backdrop-blur">
        {error ? (
          <div className="grid gap-4">
            <Alert variant="destructive" className="text-left"><AlertCircle /><span>{error}</span></Alert>
            <Button asChild variant="outline"><Link href="/friends">Go to Friends</Link></Button>
          </div>
        ) : !preview ? (
          <div className="grid justify-items-center gap-3">
            <Skeleton className="size-16 rounded-full" />
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="grid justify-items-center gap-4">
            <Avatar color={colorFor(preview.user.id)} className="size-16 text-xl">{initials(name)}</Avatar>
            {preview.status === "self" ? (
              <>
                <h1 className="text-xl font-semibold tracking-tight">This is your own invite link</h1>
                <p className="text-muted-foreground">Send it to a friend. When they open it, they can add you in one tap.</p>
                <Button asChild variant="outline"><Link href="/friends">Back to Friends</Link></Button>
              </>
            ) : preview.status === "friends" ? (
              <>
                <h1 className="text-xl font-semibold tracking-tight" data-testid="invite-done">You and {name} are friends</h1>
                <p className="text-muted-foreground">Start a room together from your Friends page, or add them to any room from its People panel.</p>
                <Button asChild variant="brand"><Link href="/friends"><Check />See your friends<ArrowRight /></Link></Button>
              </>
            ) : (
              <>
                <h1 className="text-xl font-semibold tracking-tight">{name} invited you to code together</h1>
                <p className="text-muted-foreground">Accept to add each other as friends. You can then share rooms in one click.</p>
                <Button variant="brand" size="lg" className="w-full" onClick={accept} disabled={busy} data-testid="accept-invite">
                  <UserPlus /> Accept and add {name.split(" ")[0]}
                </Button>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
