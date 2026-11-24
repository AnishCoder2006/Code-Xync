import { useEffect, useRef, useCallback } from "react";
import { Editor as MonacoEditor, DiffEditor, loader } from "@monaco-editor/react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { MonacoBinding } from "y-monaco";

// Load Monaco's AMD build from this app (public/monaco/vs, copied by
// scripts/copy-monaco.js) rather than a CDN. y-monaco shares this instance through
// src/lib/monaco-global.js.
if (typeof window !== "undefined") {
  loader.config({ paths: { vs: "/monaco/vs" } });
}

interface EditorProps {
  roomId: string;
  language: string;
  onReady?: (helpers: { getCode: () => string } & (() => string)) => void;
  // When both are non-null the component renders a side-by-side diff
  diffOriginal?: string | null;
  diffModified?: string | null;
  /** Override the sync server URL (defaults to NEXT_PUBLIC_SYNC_URL). Used by /e2e/editor. */
  syncUrl?: string;
  /** Override the auth token (defaults to the Clerk __session cookie). Used by /e2e/editor. */
  token?: string;
  /** Called with the WebsocketProvider once it exists (status/sync events, tests). */
  onProvider?: (provider: WebsocketProvider) => void;
}

export function Editor({ roomId, language, onReady, diffOriginal, diffModified, syncUrl: syncUrlProp, token: tokenProp, onProvider }: EditorProps) {
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const editorRef = useRef<any>(null);

  // Initialise Yjs + WS provider once on mount; tear down on unmount
  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    const syncUrl = syncUrlProp || process.env.NEXT_PUBLIC_SYNC_URL || "ws://localhost:4001";
    // Read the Clerk session token from the cookie for the WS handshake auth
    const token =
      tokenProp ??
      (typeof window !== "undefined"
        ? (document.cookie.match(/(?:^|; )__session=([^;]*)/) ?? [])[1] ?? ""
        : "");

    const provider = new WebsocketProvider(syncUrl, roomId, ydoc, {
      params: { token, roomId },
    });
    providerRef.current = provider;
    onProvider?.(provider);

    const getCode = () => {
      if (editorRef.current) return editorRef.current.getValue();
      return ydoc.getText("content").toString();
    };
    const helpers = Object.assign(getCode, { getCode });
    onReady?.(helpers as any);

    return () => {
      bindingRef.current?.destroy();
      provider.destroy();
      ydoc.destroy();
    };
  }, [roomId, onReady, syncUrlProp, tokenProp, onProvider]);

  // Bind Monaco to Yjs ONLY after the provider fires "synced"
  // Prevents the "cursor jumps to top / first edit is lost" bug
  const handleEditorMount = useCallback(
    (editor: any) => {
      editorRef.current = editor;
      const provider = providerRef.current;
      const ydoc = ydocRef.current;
      if (!provider || !ydoc) return;

      const bind = () => {
        const ytext = ydoc.getText("content");
        const binding = new MonacoBinding(
          ytext,
          editor.getModel()!,
          new Set([editor]),
          provider.awareness
        );
        bindingRef.current = binding;
        // Expose a stable getCode() callback so the parent page can read value
        const getCode = () => editor.getValue();
        const helpers = Object.assign(getCode, { getCode });
        onReady?.(helpers as any);
      };

      if (provider.synced) {
        bind();
      } else {
        provider.once("sync", (isSynced: boolean) => {
          if (isSynced) bind();
        });
      }
    },
    [onReady]
  );

  // Diff-preview mode: shown while the Accept/Reject bar is visible
  if (diffOriginal != null && diffModified != null) {
    return (
      <DiffEditor
        height="60vh"
        language={language}
        original={diffOriginal}
        modified={diffModified}
        options={{ readOnly: true, renderSideBySide: true }}
      />
    );
  }

  return (
    <MonacoEditor
      height="60vh"
      language={language}
      theme="vs-dark"
      options={{ fontSize: 14, minimap: { enabled: false } }}
      onMount={handleEditorMount}
    />
  );
}

export default Editor;
