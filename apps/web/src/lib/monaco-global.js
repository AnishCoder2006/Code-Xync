/**
 * Stand-in for `monaco-editor/esm/vs/editor/editor.api.js` (aliased in next.config.js).
 *
 * y-monaco imports Monaco's ESM build, but the editor itself is Monaco's AMD build
 * loaded by @monaco-editor/react (window.monaco). Two copies would mean MonacoBinding
 * builds Selection/Range objects from a different instance than the editor, and the
 * ESM build imports CSS from node_modules, which Next's pages router rejects.
 * This shim forwards every property to the single loaded instance, lazily (y-monaco
 * only touches Monaco inside functions, after the editor has mounted).
 */
const KEYS = [
  "editor",
  "languages",
  "Range",
  "Selection",
  "SelectionDirection",
  "Position",
  "Uri",
  "KeyCode",
  "KeyMod",
  "MarkerSeverity",
  "Emitter",
  "CancellationTokenSource",
];

const getMonaco = () => {
  const m = typeof window !== "undefined" ? window.monaco : undefined;
  if (!m) throw new Error("monaco-global: Monaco is not loaded yet (window.monaco missing)");
  return m;
};

for (const key of KEYS) {
  Object.defineProperty(module.exports, key, { enumerable: true, get: () => getMonaco()[key] });
}
