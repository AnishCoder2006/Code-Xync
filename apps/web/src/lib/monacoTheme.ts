// Monaco themes matching the "ink & signal" palette (globals.css): card surfaces, cobalt
// keywords, ochre strings, vermilion numbers and cursor, warm grey comments.
export const MONACO_THEME = { light: "codesync-light", dark: "codesync-dark" } as const;

let defined = false;
export function defineMonacoThemes(monaco: any) {
  if (defined) return;
  defined = true;
  monaco.editor.defineTheme(MONACO_THEME.dark, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "ede9e1" },
      { token: "keyword", foreground: "8ea2f5" },
      { token: "type", foreground: "8ea2f5" },
      { token: "string", foreground: "e3b067" },
      { token: "number", foreground: "ff7a4a" },
      { token: "comment", foreground: "8a8478", fontStyle: "italic" },
      { token: "delimiter", foreground: "b8b1a3" },
    ],
    colors: {
      "editor.background": "#1b1a18",
      "editor.foreground": "#ede9e1",
      "editor.lineHighlightBackground": "#23211e",
      "editor.lineHighlightBorder": "#23211e",
      "editorLineNumber.foreground": "#5c574d",
      "editorLineNumber.activeForeground": "#ede9e1",
      "editor.selectionBackground": "#3a2a22",
      "editor.inactiveSelectionBackground": "#2e2621",
      "editorCursor.foreground": "#ff5a1f",
      "editorGutter.background": "#1b1a18",
      "editorIndentGuide.background1": "#2e2c28",
      "editorWhitespace.foreground": "#3a3833",
      "scrollbarSlider.background": "#ede9e11f",
      "diffEditor.insertedTextBackground": "#5bbe8426",
      "diffEditor.removedTextBackground": "#f0605a26",
      "diffEditor.insertedLineBackground": "#5bbe8414",
      "diffEditor.removedLineBackground": "#f0605a14",
    },
  });
  monaco.editor.defineTheme(MONACO_THEME.light, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "", foreground: "161513" },
      { token: "keyword", foreground: "2b4acb" },
      { token: "type", foreground: "2b4acb" },
      { token: "string", foreground: "9a5a0c" },
      { token: "number", foreground: "c2410c" },
      { token: "comment", foreground: "8a8478", fontStyle: "italic" },
      { token: "delimiter", foreground: "57534a" },
    ],
    colors: {
      "editor.background": "#fbfaf6",
      "editor.foreground": "#161513",
      "editor.lineHighlightBackground": "#f2eee5",
      "editor.lineHighlightBorder": "#f2eee5",
      "editorLineNumber.foreground": "#b3ad9f",
      "editorLineNumber.activeForeground": "#161513",
      "editor.selectionBackground": "#ffd9c7",
      "editor.inactiveSelectionBackground": "#f5e6dc",
      "editorCursor.foreground": "#e8481c",
      "editorGutter.background": "#fbfaf6",
      "editorIndentGuide.background1": "#e4dfd3",
      "diffEditor.insertedTextBackground": "#2f7d4f22",
      "diffEditor.removedTextBackground": "#c2322e22",
      "diffEditor.insertedLineBackground": "#2f7d4f10",
      "diffEditor.removedLineBackground": "#c2322e10",
    },
  });
}
