import { useEffect, useRef, useCallback } from "react";
import { Editor as MonacoEditor, loader } from "@monaco-editor/react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { MonacoBinding } from "y-monaco";
import { SYNC_URL } from "../lib/api";
import { MONACO_THEME, defineMonacoThemes } from "../lib/monacoTheme";
import { CUSTOM_FORMAT_IDS, formatCode, textEdits } from "../lib/format";

// Load Monaco's AMD build from this app (public/monaco/vs, copied by
// scripts/copy-monaco.js) rather than a CDN. y-monaco shares this instance through
// src/lib/monaco-global.js.
if (typeof window !== "undefined") {
  loader.config({ paths: { vs: "/monaco/vs" } });
}

export type ConnState = "connecting" | "connected" | "reconnecting" | "offline";
export type PresenceUser = { id: string; name: string; color: string };
export type FormatResult = "formatted" | "unchanged" | "unsupported";
/** Handed to the page once the editor is ready (and again when it binds). */
export type EditorHelpers = {
  getCode: () => string;
  reveal: (startLine: number, endLine: number) => void;
  /** Formats the whole file (same as Shift+Alt+F); one undo step, synced to everyone. */
  format: () => Promise<FormatResult>;
};

/**
 * Monaco formats JavaScript and TypeScript itself; every other room language gets
 * lib/format.ts as its document formatter, so the Format button, the context menu's
 * "Format Document" and Shift+Alt+F all behave the same. Registered once per page.
 */
let formattersRegistered = false;
function registerFormatters(monaco: any) {
  if (formattersRegistered) return;
  formattersRegistered = true;
  for (const id of CUSTOM_FORMAT_IDS) {
    monaco.languages.registerDocumentFormattingEditProvider(id, {
      displayName: "codexync",
      provideDocumentFormattingEdits(model: any) {
        const before = model.getValue();
        return textEdits(before, formatCode(before, id)).map((e) => {
          const s = model.getPositionAt(e.start);
          const en = model.getPositionAt(e.end);
          return { range: new monaco.Range(s.lineNumber, s.column, en.lineNumber, en.column), text: e.text };
        });
      },
    });
  }
}

interface EditorProps {
  roomId: string;
  language: string;
  onReady?: (helpers: EditorHelpers & (() => string)) => void;
  /** Override the sync server URL (defaults to NEXT_PUBLIC_SYNC_URL). */
  syncUrl?: string;
  /** Fixed auth token (used by /e2e/editor). */
  token?: string;
  /** Token source; called before the first connect and again before reconnects. */
  getToken?: () => Promise<string | null>;
  /** Shown to others: avatar, cursor label and colour. */
  user?: PresenceUser;
  readOnly?: boolean;
  theme?: "light" | "dark";
  height?: string;
  /** Called with the WebsocketProvider once it exists (status/sync events, tests). */
  onProvider?: (provider: WebsocketProvider) => void;
  onStatus?: (state: ConnState) => void;
}

const cssString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/[\n\r]/g, " ")}"`;

/** Per-client colours + name labels for y-monaco's remote selection decorations. */
function remoteCursorCss(provider: WebsocketProvider): string {
  const rules: string[] = [];
  provider.awareness.getStates().forEach((state: any, clientId: number) => {
    if (clientId === provider.awareness.clientID || !state?.user) return;
    const color = /^#[0-9a-f]{6}$/i.test(state.user.color) ? state.user.color : "#0891b2";
    const name = String(state.user.name ?? "Anonymous").slice(0, 40);
    rules.push(
      `.yRemoteSelection-${clientId}{background-color:${color}38}`,
      `.yRemoteSelectionHead-${clientId}{position:absolute;height:100%;border-left:2px solid ${color};box-sizing:border-box}`,
      `.yRemoteSelectionHead-${clientId}::after{content:${cssString(name)};position:absolute;left:-2px;top:-1.35em;` +
        `padding:0 5px;border-radius:4px 4px 4px 0;background:${color};color:#fff;font:600 11px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;` +
        `white-space:nowrap;pointer-events:none;z-index:10}`
    );
  });
  return rules.join("\n");
}

export function Editor({
  roomId, language, onReady, syncUrl: syncUrlProp, token: tokenProp, getToken, user,
  readOnly = false, theme = "dark", height = "60vh", onProvider, onStatus,
}: EditorProps) {
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const editorRef = useRef<any>(null);
  const pendingMountRef = useRef<any>(null);
  // Latest values for callbacks that must not re-create the provider.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const userRef = useRef(user);
  userRef.current = user;

  const format = useCallback(async (): Promise<FormatResult> => {
    const ed = editorRef.current;
    const action = ed?.getAction("editor.action.formatDocument");
    if (!ed || !action || !action.isSupported()) return "unsupported";
    const before = ed.getValue();
    await action.run();
    return ed.getValue() === before ? "unchanged" : "formatted";
  }, []);

  const bindEditor = useCallback(
    (editor: any) => {
      const provider = providerRef.current;
      const ydoc = ydocRef.current;
      if (!provider || !ydoc) {
        pendingMountRef.current = editor; // provider not created yet (awaiting token)
        return;
      }
      const bind = () => {
        if (bindingRef.current || editor.getModel() == null) return;
        bindingRef.current = new MonacoBinding(ydoc.getText("content"), editor.getModel()!, new Set([editor]), provider.awareness);
        const getCode = () => editor.getValue();
        const reveal = (startLine: number, endLine: number) => {
          const model = editor.getModel();
          if (!model) return;
          const end = Math.min(Math.max(endLine, startLine), model.getLineCount());
          editor.revealLinesInCenter(startLine, end);
          editor.setSelection({ startLineNumber: startLine, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) });
          editor.focus();
        };
        onReady?.(Object.assign(getCode, { getCode, reveal, format }) as any);
      };
      // Bind only after the first sync: binding earlier loses the first edit / jumps the cursor.
      if (provider.synced) bind();
      else provider.once("sync", (isSynced: boolean) => isSynced && bind());
    },
    [onReady, format]
  );

  // Yjs doc + WebSocket provider; one per room.
  useEffect(() => {
    let disposed = false;
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const style = document.createElement("style");
    style.dataset.codesync = "remote-cursors";
    document.head.appendChild(style);
    let provider: WebsocketProvider | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let everConnected = false;

    const report = () => {
      if (!provider) return;
      const p = provider;
      const state: ConnState = !navigator.onLine
        ? "offline"
        : p.wsconnected && p.synced
        ? "connected"
        : everConnected
        ? "reconnecting"
        : "connecting";
      onStatusRef.current?.(state);
    };

    const start = async () => {
      let token = tokenProp ?? "";
      if (!tokenProp && getTokenRef.current) token = (await getTokenRef.current().catch(() => null)) ?? "";
      if (disposed) return;

      provider = new WebsocketProvider(syncUrlProp || SYNC_URL, roomId, ydoc, {
        params: { token, roomId },
        // One path for every update: through the server, which enforces roles.
        disableBc: true,
      });
      providerRef.current = provider;
      const p = provider;
      if (userRef.current) {
        const u = userRef.current;
        p.awareness.setLocalStateField("user", { userId: u.id, name: u.name, color: u.color });
      }

      const refreshToken = async () => {
        if (tokenProp || !getTokenRef.current) return;
        const t = await getTokenRef.current().catch(() => null);
        if (t) p.params.token = t; // y-websocket builds the URL from params on every (re)connect
      };
      // Clerk session tokens are short-lived; keep the reconnect URL fresh.
      refreshTimer = setInterval(refreshToken, 30_000);
      p.on("status", ({ status }: { status: string }) => {
        if (status === "connected") everConnected = true;
        if (status === "disconnected") refreshToken();
        report();
      });
      p.on("sync", report);
      p.awareness.on("change", () => (style.textContent = remoteCursorCss(p)));
      onProvider?.(p);
      report();

      const getCode = () => (editorRef.current ? editorRef.current.getValue() : ydoc.getText("content").toString());
      onReady?.(Object.assign(getCode, { getCode, reveal: () => {}, format }) as any);

      if (pendingMountRef.current) {
        const ed = pendingMountRef.current;
        pendingMountRef.current = null;
        bindEditor(ed);
      }
    };
    start();
    window.addEventListener("online", report);
    window.addEventListener("offline", report);

    return () => {
      disposed = true;
      window.removeEventListener("online", report);
      window.removeEventListener("offline", report);
      clearInterval(refreshTimer);
      bindingRef.current?.destroy();
      bindingRef.current = null;
      provider?.destroy();
      providerRef.current = null;
      ydoc.destroy();
      style.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, syncUrlProp, tokenProp]);

  // Presence identity can arrive after the provider (user profile loads late).
  useEffect(() => {
    if (user && providerRef.current) {
      providerRef.current.awareness.setLocalStateField("user", { userId: user.id, name: user.name, color: user.color });
    }
  }, [user?.id, user?.name, user?.color]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleEditorMount = useCallback(
    (editor: any, monaco: any) => {
      editorRef.current = editor;
      registerFormatters(monaco);
      bindEditor(editor);
    },
    [bindEditor]
  );

  return (
    <MonacoEditor
      height={height}
      language={language}
      theme={MONACO_THEME[theme]}
      beforeMount={defineMonacoThemes}
      options={{
        fontSize: 14.5,
        lineHeight: 22,
        minimap: { enabled: false },
        readOnly,
        readOnlyMessage: { value: "You're a viewer in this room, so you can't edit." },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        padding: { top: 12 },
        fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      }}
      onMount={handleEditorMount}
    />
  );
}

export default Editor;
