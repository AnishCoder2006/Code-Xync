import { useEffect, useRef, useCallback } from "react";
import { Editor as MonacoEditor, DiffEditor } from "@monaco-editor/react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { MonacoBinding } from "y-monaco";

interface EditorProps {
  roomId: string;
  language: string;
  onReady?: (helpers: { getCode: () => string; applyPatch: (patch: string) => void } & (() => string)) => void;
  // When both are non-null the component renders a side-by-side diff
  diffOriginal?: string | null;
  diffModified?: string | null;
}

export function Editor({ roomId, language, onReady, diffOriginal, diffModified }: EditorProps) {
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const editorRef = useRef<any>(null);

  const applyPatch = useCallback((patch: string) => {
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    const ytext = ydoc.getText("content");
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, patch);
    });
  }, []);

  // Initialise Yjs + WS provider once on mount; tear down on unmount
  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    const syncUrl = process.env.NEXT_PUBLIC_SYNC_URL || "ws://localhost:4001";
    // Read the Clerk session token from the cookie for the WS handshake auth
    const token =
      typeof window !== "undefined"
        ? (document.cookie.match(/(?:^|; )__session=([^;]*)/) ?? [])[1] ?? ""
        : "";

    const provider = new WebsocketProvider(syncUrl, roomId, ydoc, {
      params: { token, roomId },
    });
    providerRef.current = provider;

    const getCode = () => {
      if (editorRef.current) return editorRef.current.getValue();
      return ydoc.getText("content").toString();
    };
    const helpers = Object.assign(getCode, { getCode, applyPatch });
    onReady?.(helpers as any);

    return () => {
      bindingRef.current?.destroy();
      provider.destroy();
      ydoc.destroy();
    };
  }, [roomId, onReady, applyPatch]);

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
        const helpers = Object.assign(getCode, { getCode, applyPatch });
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
    [onReady, applyPatch]
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
