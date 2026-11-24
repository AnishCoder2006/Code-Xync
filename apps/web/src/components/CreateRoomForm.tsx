import { useState, type FormEvent } from "react";
import { AlertCircle, Plus } from "lucide-react";
import { api, describeError, type GetToken, type Language, type RoomDetail } from "../lib/api";
import { Button } from "./ui/button";
import { Field, Input, Label, Switch } from "./ui/form";
import { Alert, Spinner } from "./ui/display";
import { LanguageSelect } from "./LanguageSelect";
import { languageInfo } from "../lib/languages";

export function CreateRoomForm({ getToken, onCreated }: { getToken: GetToken; onCreated: (roomId: string) => void }) {
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<Language>("python");
  const [isPrivate, setIsPrivate] = useState(true);
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError("Give the room a name.");
    setBusy(true);
    setError(null);
    try {
      const room = await api<RoomDetail>(getToken, "/rooms", {
        body: { title: title.trim(), language, isPrivate, ...(passcode ? { passcode } : {}) },
      });
      onCreated(room.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4" data-testid="create-form" noValidate>
      <Field label="Room name" htmlFor="room-title">
        <Input id="room-title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Pairing on the parser" />
      </Field>
      <Field
        label="Language"
        htmlFor="room-language"
        hint={languageInfo(language).run ? "Edit together, run in the sandbox, and ask for AI fixes." : "Edit together with highlighting. Running and AI fixes are not available for this language yet."}
      >
        <LanguageSelect id="room-language" value={language} onChange={(v) => setLanguage(v)} />
      </Field>
      <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2.5">
        <div className="grid gap-0.5">
          <Label htmlFor="room-private">Private room</Label>
          <span className="text-xs text-muted-foreground">Only people with the link can join.</span>
        </div>
        <Switch id="room-private" checked={isPrivate} onCheckedChange={setIsPrivate} />
      </div>
      <Field label={<>Passcode <span className="font-normal opacity-70">(optional)</span></>} hint="People joining with the room ID will need it." htmlFor="room-passcode">
        <Input id="room-passcode" name="passcode" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="new-password" />
      </Field>
      {error && (
        <Alert variant="destructive" data-testid="create-error">
          <AlertCircle />
          <span>{error}</span>
        </Alert>
      )}
      <Button type="submit" variant="brand" disabled={busy}>
        {busy ? <Spinner /> : <Plus />}
        Create room
      </Button>
    </form>
  );
}
