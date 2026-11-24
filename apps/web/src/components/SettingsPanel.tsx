/**
 * Room settings: owners rename, change language and privacy, set or remove the passcode,
 * and delete the room (PATCH / DELETE /rooms/:id). Others see the room's details.
 */
import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, describeError, languageLabel, roleLabel, type GetToken, type RoomDetail } from "../lib/api";
import { languageInfo } from "../lib/languages";
import { timeAgo } from "../lib/util";
import { LanguageSelect } from "./LanguageSelect";
import { Button } from "./ui/button";
import { Field, Input, Label, Switch } from "./ui/form";
import { Alert, Separator, Spinner } from "./ui/display";

type Props = { room: RoomDetail; getToken: GetToken; onSaved: () => void; onDeleted: () => void };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium">{children}</span>
    </div>
  );
}

export function SettingsPanel({ room, getToken, onSaved, onDeleted }: Props) {
  const isOwner = room.myRole === "OWNER";
  const [title, setTitle] = useState(room.title);
  const [language, setLanguage] = useState(room.language);
  const [isPrivate, setIsPrivate] = useState(room.isPrivate);
  const [newPasscode, setNewPasscode] = useState("");
  const [busy, setBusy] = useState<null | "save" | "passcode" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setTitle(room.title);
    setLanguage(room.language);
    setIsPrivate(room.isPrivate);
  }, [room.title, room.language, room.isPrivate]);

  const patch = async (body: Record<string, unknown>, kind: "save" | "passcode", ok: string) => {
    setBusy(kind);
    setError(null);
    try {
      await api(getToken, `/rooms/${encodeURIComponent(room.id)}`, { method: "PATCH", body });
      toast.success(ok);
      onSaved();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (title.trim() !== room.title) body.title = title.trim();
    if (language !== room.language) body.language = language;
    if (isPrivate !== room.isPrivate) body.isPrivate = isPrivate;
    if (Object.keys(body).length === 0) return setError("Nothing changed.");
    patch(body, "save", "Room settings saved");
  };

  const deleteRoom = async () => {
    setBusy("delete");
    setError(null);
    try {
      await api(getToken, `/rooms/${encodeURIComponent(room.id)}`, { method: "DELETE" });
      toast.success(`Deleted “${room.title}”`);
      onDeleted();
    } catch (err) {
      setError(describeError(err));
      setBusy(null);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(room.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the ID is visible and selectable anyway */
    }
  };

  const dirty = title.trim() !== room.title || language !== room.language || isPrivate !== room.isPrivate;

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4" data-testid="settings-panel">
      <div>
        <h2 className="text-[15px] font-semibold">Room settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">{isOwner ? "Only you, the owner, can change these." : "Only the owner can change these."}</p>
      </div>

      <div>
        <Row label="Room ID">
          <button type="button" onClick={copyId} className="inline-flex max-w-[210px] items-center gap-1.5 font-mono text-xs hover:text-cobalt" title="Copy room ID">
            <span className="truncate">{room.id}</span>
            {copied ? <Check className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0" />}
          </button>
        </Row>
        <Row label="Created">{timeAgo(room.createdAt)}</Row>
        <Row label="Members">{room.members.length}</Row>
        <Row label="Your role">{roleLabel(room.myRole)}</Row>
        {!isOwner && <Row label="Language">{languageLabel(room.language)}</Row>}
        {!isOwner && <Row label="Passcode">{room.hasPasscode ? "Required to join" : "None"}</Row>}
      </div>

      {error && <Alert variant="destructive"><AlertCircle /><span>{error}</span></Alert>}

      {isOwner && (
        <>
          <form onSubmit={save} className="grid gap-4">
            <Field label="Name" htmlFor="set-title">
              <Input id="set-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} data-testid="settings-title" />
            </Field>
            <Field
              label="Language"
              htmlFor="set-language"
              hint={languageInfo(language).run ? "Run and AI fixes available." : "Edit only: Run and AI fixes are not available for this language."}
            >
              <LanguageSelect id="set-language" value={language} onChange={setLanguage} testId="settings-language" />
            </Field>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div className="grid gap-0.5">
                <Label htmlFor="set-private">Private room</Label>
                <span className="text-xs text-muted-foreground">Only people with the link can join.</span>
              </div>
              <Switch id="set-private" checked={isPrivate} onCheckedChange={setIsPrivate} />
            </div>
            <Button type="submit" disabled={!dirty || busy !== null} data-testid="settings-save">
              {busy === "save" && <Spinner />} Save changes
            </Button>
          </form>

          <Separator />

          <section className="grid gap-3" aria-label="Passcode">
            <div className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="size-4" />
              Passcode <span className="font-normal text-muted-foreground">· {room.hasPasscode ? "required to join" : "not set"}</span>
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder={room.hasPasscode ? "New passcode" : "Set a passcode"}
                value={newPasscode}
                onChange={(e) => setNewPasscode(e.target.value)}
                autoComplete="new-password"
                aria-label="New passcode"
              />
              <Button
                variant="outline"
                disabled={!newPasscode || busy !== null}
                onClick={async () => (await patch({ passcode: newPasscode }, "passcode", "Passcode updated")) && setNewPasscode("")}
              >
                Set
              </Button>
            </div>
            {room.hasPasscode && (
              <Button variant="ghost" size="sm" className="w-fit" disabled={busy !== null} onClick={() => patch({ passcode: null }, "passcode", "Passcode removed")}>
                Remove passcode
              </Button>
            )}
            <p className="text-xs text-muted-foreground">Changing it does not remove people who already joined.</p>
          </section>

          <Separator />

          <section className="grid gap-3 rounded-md border border-destructive/40 p-3" aria-label="Danger zone">
            <div className="text-sm font-semibold text-destructive">Delete this room</div>
            <p className="text-sm text-muted-foreground">
              Removes the code, members, run history and AI history for everyone. Open editors disconnect. This cannot be undone.
            </p>
            <Input
              placeholder={`Type “${room.title}” to confirm`}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              aria-label="Type the room name to confirm deletion"
              data-testid="delete-confirm"
            />
            <Button variant="destructive" disabled={confirmName !== room.title || busy !== null} onClick={deleteRoom} data-testid="delete-room">
              {busy === "delete" ? <Spinner /> : <Trash2 />} Delete room
            </Button>
          </section>
        </>
      )}
    </div>
  );
}
