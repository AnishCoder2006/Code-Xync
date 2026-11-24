import { useState, type FormEvent } from "react";
import { AlertCircle, LogIn } from "lucide-react";
import { ApiError, api, describeError, type GetToken } from "../lib/api";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/form";
import { Alert, Spinner } from "./ui/display";

/** Accepts a bare room ID or an invite link (…/room/<id>). */
export function parseRoomId(input: string): string {
  const s = input.trim();
  const m = s.match(/\/room\/([^/?#\s]+)/);
  return decodeURIComponent(m ? m[1] : s);
}

type Props = {
  getToken: GetToken;
  onJoined: (roomId: string) => void;
  /** Fixed room (invite link opened by a non-member): hide the ID field. */
  roomId?: string;
};

export function JoinRoomForm({ getToken, onJoined, roomId: fixedRoomId }: Props) {
  const [roomInput, setRoomInput] = useState("");
  const [passcode, setPasscode] = useState("");
  const [needsPasscode, setNeedsPasscode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const roomId = fixedRoomId ?? parseRoomId(roomInput);
    if (!roomId) return setError("Enter a room ID or invite link.");
    setBusy(true);
    setError(null);
    try {
      await api(getToken, `/rooms/${encodeURIComponent(roomId)}/join`, { body: passcode ? { passcode } : {} });
      onJoined(roomId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && /passcode/i.test(err.data?.error ?? "")) {
        setNeedsPasscode(true);
        setError(/invalid/i.test(err.data.error) ? "That passcode is not correct." : "This room needs a passcode.");
      } else if (err instanceof ApiError && err.status === 404) {
        setError("No room with that ID. Check the invite link.");
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4" data-testid="join-form" noValidate>
      {!fixedRoomId && (
        <Field label="Room ID or invite link" htmlFor="join-room">
          <Input
            id="join-room"
            name="roomId"
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            placeholder="https://…/room/abc123 or abc123"
            autoComplete="off"
          />
        </Field>
      )}
      <Field label={needsPasscode ? "Passcode" : <>Passcode <span className="font-normal opacity-70">(if the room has one)</span></>} htmlFor="join-passcode">
        <Input id="join-passcode" name="passcode" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="off" />
      </Field>
      {error && (
        <Alert variant="destructive" data-testid="join-error">
          <AlertCircle />
          <span>{error}</span>
        </Alert>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? <Spinner /> : <LogIn />}
        Join room
      </Button>
    </form>
  );
}
