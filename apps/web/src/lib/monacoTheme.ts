// Monaco themes matching the CodeSync palette (globals.css): card surfaces, teal + amber.
export const MONACO_THEME = { light: "codesync-light", dark: "codesync-dark" } as const;

let defined = false;
export function defineMonacoThemes(monaco: any) {
  if (defined) return;
  defined = true;
  monaco.editor.defineTheme(MONACO_THEME.dark, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "2dd4bf" },
      { token: "string", foreground: "fbbf24" },
      { token: "number", foreground: "fb923c" },
      { token: "comment", foreground: "6b8a8f", fontStyle: "italic" },
    ],
    colors: {
      "editor.background": "#111a1d",
      "editor.lineHighlightBackground": "#17242a",
      "editorLineNumber.foreground": "#4a6168",
      "editorLineNumber.activeForeground": "#9fb7bb",
      "editor.selectionBackground": "#1f4a45",
      "editorCursor.foreground": "#2dd4bf",
      "editorGutter.background": "#111a1d",
      "diffEditor.insertedTextBackground": "#22c55e26",
      "diffEditor.removedTextBackground": "#ef444426",
    },
  });
  monaco.editor.defineTheme(MONACO_THEME.light, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "0f766e" },
      { token: "string", foreground: "b45309" },
      { token: "number", foreground: "c2410c" },
      { token: "comment", foreground: "7c8b8f", fontStyle: "italic" },
    ],
    colors: {
      "editor.background": "#fefdfb",
      "editor.lineHighlightBackground": "#f4f1ea",
      "editorLineNumber.foreground": "#b3b8b6",
      "editorLineNumber.activeForeground": "#4b5a5e",
      "editor.selectionBackground": "#c9ece6",
      "editorCursor.foreground": "#0f766e",
      "editorGutter.background": "#fefdfb",
    },
  });
}
