/**
 * "Format code" for every room language that Monaco has no formatter for.
 * (JavaScript and TypeScript use Monaco's own TypeScript formatter.)
 *
 * Safety rule: the formatter only ever changes whitespace (plus keyword case in SQL).
 * Strings, comments and multi-line string bodies are never touched, so a formatted
 * program always means exactly what it meant before. tests/test-format.ts checks this
 * on samples in every language: strip all whitespace from the input and the output and
 * they must be identical.
 *
 * Styles:
 *   braces   C, C++, C#, Java, Go, Rust, Kotlin, Swift, Scala, Dart, PHP, Solidity, R,
 *            PowerShell, Perl: re-indent by {[( depth, case labels, operator/comma spacing
 *   end      Ruby, Lua, Elixir, Julia, Pascal, Visual Basic: re-indent by block keywords
 *   shell    Bash: if/fi, do/done, case/esac, { }
 *   lisp     Clojure, Scheme: indent by paren depth
 *   python   Python: normalise indentation to 4 spaces per level, PEP 8 spacing and blank lines
 *   sql      one clause per line, upper-case keywords
 *   plain    F#, CoffeeScript (indentation is syntax): whitespace clean-up only
 */

type Style = "braces" | "end" | "shell" | "lisp" | "python" | "sql" | "plain";

type Lang = {
  style: Style;
  indent: string;
  lineComments: string[];
  blockComments: [string, string][];
  /** Longest first. Delimiters in `multiline` may span lines. */
  strings: string[];
  multiline: string[];
  /** ' only opens a char literal when it really is one ('x', '\n'), e.g. Rust lifetimes 'a. */
  strictChar?: boolean;
  /** Add spaces around = == += => etc. Off where / starts a regex or = is part of syntax. */
  operatorSpacing?: boolean;
  /** Go-style switch: case labels at the switch's own level. */
  caseOutdent?: boolean;
  /** C preprocessor lines stay in column 0. */
  preprocessor?: boolean;
  /** Keyword rules for the "end" style. */
  blocks?: (code: string) => { opens: number; closes: number; leadingClose: boolean; middle: boolean };
};

const SP4 = "    ";
const SP2 = "  ";
const C_COMMENTS = { lineComments: ["//"], blockComments: [["/*", "*/"]] as [string, string][] };
const cLike = (extra: Partial<Lang> = {}): Lang => ({
  style: "braces",
  indent: SP4,
  ...C_COMMENTS,
  strings: ['"', "'"],
  multiline: [],
  strictChar: true,
  operatorSpacing: true,
  ...extra,
});

const count = (s: string, re: RegExp) => (s.match(re) || []).length;

const rubyBlocks = (code: string) => {
  const t = code.trim();
  const startsOpener = /^(def|class|module|if|unless|while|until|case|begin|for)\b/.test(t);
  const doOpens = count(t, /\bdo\b(\s*\|[^|]*\|)?\s*$/g);
  const ends = count(t, /\bend\b/g);
  return {
    opens: (startsOpener ? 1 : 0) + doOpens,
    closes: ends,
    leadingClose: /^end\b/.test(t),
    middle: /^(else|elsif|when|in|rescue|ensure)\b/.test(t),
  };
};
const luaBlocks = (code: string) => {
  const t = code.trim();
  const middle = /^(else|elseif)\b/.test(t);
  return {
    opens: count(t, /\bfunction\b/g) + (middle ? 0 : count(t, /\bthen\b/g)) + count(t, /\bdo\b/g) + count(t, /\brepeat\b/g),
    closes: count(t, /\bend\b/g) + count(t, /\buntil\b/g),
    leadingClose: /^(end|until)\b/.test(t),
    middle,
  };
};
const elixirBlocks = (code: string) => {
  const t = code.trim();
  return {
    opens: count(t, /\bdo\s*$/g) + count(t, /\bfn\b/g),
    closes: count(t, /\bend\b/g),
    leadingClose: /^end\b/.test(t),
    middle: /^(else|rescue|catch|after)\b/.test(t),
  };
};
const juliaBlocks = (code: string) => {
  const t = code.trim();
  const starts = /^(function|if|for|while|begin|let|struct|mutable\s+struct|module|baremodule|macro|quote|try)\b/.test(t);
  return {
    opens: (starts ? 1 : 0) + count(t, /\bdo\b(\s+[\w, ()]*)?\s*$/g),
    closes: count(t, /\bend\b/g),
    leadingClose: /^end\b/.test(t),
    middle: /^(else|elseif|catch|finally)\b/.test(t),
  };
};
const pascalBlocks = (code: string) => {
  const t = code.trim().toLowerCase();
  return {
    opens: count(t, /\b(begin|record|try|repeat)\b/g) + count(t, /\bcase\b.*\bof\b/g),
    closes: count(t, /\b(end|until)\b/g),
    leadingClose: /^(end|until)\b/.test(t),
    middle: /^(except|finally)\b/.test(t),
  };
};
const vbBlocks = (code: string) => {
  const t = code.trim();
  const decl = /^((public|private|friend|protected|shared|overrides|overridable|mustoverride|readonly|partial|static)\s+)*(sub|function|class|module|structure|interface|enum|property|namespace|operator)\b/i;
  const opener =
    (decl.test(t) && !/^(.*\s)?(declare|mustoverride)\s/i.test(t)) ||
    /^(select\s+case|try|with|using|synclock|while|do|for)\b/i.test(t) ||
    (/^if\b/i.test(t) && /\bthen\s*$/i.test(t));
  const closer = /^(end(?!\s*\()\b|next\b|loop\b|wend\b)/i.test(t);
  return {
    opens: opener ? 1 : 0,
    closes: closer ? 1 : 0,
    leadingClose: closer,
    middle: /^(else|elseif|case|catch|finally)\b/i.test(t),
  };
};

const LANGS: Record<string, Lang> = {
  c: cLike({ preprocessor: true }),
  cpp: cLike({ preprocessor: true }),
  csharp: cLike({ preprocessor: true, strings: ['"""', '"', "'"], multiline: ['"""'] }),
  java: cLike({ strings: ['"""', '"', "'"], multiline: ['"""'] }),
  go: cLike({ indent: "\t", caseOutdent: true, strings: ['"', "'", "`"], multiline: ["`"] }),
  rust: cLike(),
  kotlin: cLike({ strings: ['"""', '"', "'"], multiline: ['"""'] }),
  swift: cLike({ strings: ['"""', '"'], multiline: ['"""'] }),
  scala: cLike({ indent: SP2, strings: ['"""', '"', "'"], multiline: ['"""'] }),
  dart: cLike({ indent: SP2, strings: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"], strictChar: false }),
  php: cLike({ lineComments: ["//", "#"], strictChar: false }),
  sol: cLike({ strictChar: false }),
  r: cLike({ indent: SP2, lineComments: ["#"], blockComments: [], strictChar: false, operatorSpacing: false }),
  powershell: cLike({ lineComments: ["#"], blockComments: [["<#", "#>"]], strictChar: false, operatorSpacing: false }),
  perl: cLike({ lineComments: ["#"], blockComments: [], strictChar: false, operatorSpacing: false }),
  // Fallback only: Monaco formats JS/TS itself. No operator spacing (regex literals).
  javascript: cLike({ indent: SP2, strings: ['"', "'", "`"], multiline: ["`"], strictChar: false, operatorSpacing: false }),
  typescript: cLike({ indent: SP2, strings: ['"', "'", "`"], multiline: ["`"], strictChar: false, operatorSpacing: false }),

  ruby: { style: "end", indent: SP2, lineComments: ["#"], blockComments: [["=begin", "=end"]], strings: ['"', "'"], multiline: [], blocks: rubyBlocks },
  lua: { style: "end", indent: SP4, lineComments: ["--"], blockComments: [["--[[", "]]"]], strings: ["[[", '"', "'"], multiline: ["[["], blocks: luaBlocks },
  elixir: { style: "end", indent: SP2, lineComments: ["#"], blockComments: [], strings: ['"""', '"', "'"], multiline: ['"""'], blocks: elixirBlocks },
  julia: { style: "end", indent: SP4, lineComments: ["#"], blockComments: [["#=", "=#"]], strings: ['"""', '"'], multiline: ['"""'], blocks: juliaBlocks },
  pascal: { style: "end", indent: SP2, lineComments: ["//"], blockComments: [["{", "}"], ["(*", "*)"]], strings: ["'"], multiline: [], blocks: pascalBlocks },
  vb: { style: "end", indent: SP4, lineComments: ["'"], blockComments: [], strings: ['"'], multiline: [], blocks: vbBlocks },

  shell: { style: "shell", indent: SP4, lineComments: ["#"], blockComments: [], strings: ['"', "'"], multiline: ['"', "'"] },
  clojure: { style: "lisp", indent: SP2, lineComments: [";"], blockComments: [], strings: ['"'], multiline: ['"'] },
  scheme: { style: "lisp", indent: SP2, lineComments: [";"], blockComments: [["#|", "|#"]], strings: ['"'], multiline: ['"'] },
  python: { style: "python", indent: SP4, lineComments: ["#"], blockComments: [], strings: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"] },
  sql: { style: "sql", indent: SP2, lineComments: ["--"], blockComments: [["/*", "*/"]], strings: ["'", '"'], multiline: ["'"] },
  fsharp: { style: "plain", indent: SP4, lineComments: ["//"], blockComments: [["(*", "*)"]], strings: ['"""', '"'], multiline: ['"""'] },
  coffeescript: { style: "plain", indent: SP2, lineComments: ["#"], blockComments: [["###", "###"]], strings: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"] },
};

/** True when this module can format the Monaco language id. */
export const canFormat = (monacoId: string) => monacoId in LANGS;
/** Monaco language ids that need our formatter (Monaco formats JS/TS itself). */
export const CUSTOM_FORMAT_IDS = Object.keys(LANGS).filter((id) => id !== "javascript" && id !== "typescript");

// ── Scanner: splits a line into code / string / comment segments ────────────
type Seg = { kind: "code" | "str" | "comment"; text: string };
type ScanState = { mode: "code" } | { mode: "block"; close: string } | { mode: "str"; delim: string };

function scanLine(line: string, state: ScanState, L: Lang): { segs: Seg[]; state: ScanState } {
  const segs: Seg[] = [];
  const push = (kind: Seg["kind"], text: string) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segs.push({ kind, text });
  };
  let i = 0;
  let st = state;
  while (i < line.length) {
    if (st.mode === "block") {
      const end = line.indexOf(st.close, i);
      if (end < 0) { push("comment", line.slice(i)); i = line.length; break; }
      push("comment", line.slice(i, end + st.close.length));
      i = end + st.close.length;
      st = { mode: "code" };
      continue;
    }
    if (st.mode === "str") {
      const d = st.delim;
      const closeDelim = d === "[[" ? "]]" : d;
      let j = i;
      let closed = false;
      while (j < line.length) {
        if (line[j] === "\\" && d !== "`" && d !== "[[" && !(d === "'" && L.style === "shell")) { j += 2; continue; }
        if (line.startsWith(closeDelim, j)) { j += closeDelim.length; closed = true; break; }
        j++;
      }
      push("str", line.slice(i, Math.min(j, line.length)));
      i = Math.min(j, line.length);
      if (closed) st = { mode: "code" };
      else if (!L.multiline.includes(d)) st = { mode: "code" }; // unterminated single-line string
      continue;
    }
    // code
    const rest = line.slice(i);
    const lc = L.lineComments.find((m) => rest.startsWith(m) && !(m === "#" && L.style === "shell" && i > 0 && /[$\w{]/.test(line[i - 1])));
    const bc = L.blockComments.find(([o]) => rest.startsWith(o));
    if (bc && (!lc || bc[0].length >= lc.length)) {
      push("comment", bc[0]);
      i += bc[0].length;
      st = { mode: "block", close: bc[1] };
      continue;
    }
    if (lc) { push("comment", rest); i = line.length; break; }
    if (L.style === "lisp" && line[i] === "\\") { push("code", line.slice(i, i + 2)); i += 2; continue; }
    const delim = L.strings.find((d) => rest.startsWith(d));
    if (delim) {
      if (delim === "'" && L.strictChar && !/^'(\\.[^']*|[^\\'])'/.test(rest)) { push("code", "'"); i++; continue; }
      push("str", delim);
      i += delim.length;
      st = { mode: "str", delim };
      continue;
    }
    push("code", line[i]);
    i++;
  }
  // Line comments and single-line strings never continue onto the next line.
  if (st.mode === "str" && !L.multiline.includes(st.delim)) st = { mode: "code" };
  return { segs, state: st };
}

const codeOnly = (segs: Seg[]) => segs.map((s) => (s.kind === "code" ? s.text : s.kind === "str" ? '""' : "")).join("");

// ── Intra-line spacing (code segments only) ─────────────────────────────────
const OPS = [">>>=", "<<=", ">>=", "===", "!==", "<=>", "**=", "??=", "//=", "..=", "=~", "!~", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", ":=", "=>", "="];

function spaceOperators(code: string, isLast: boolean): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const op = OPS.find((o) => code.startsWith(o, i));
    if (op === "..=") { out += op; i += op.length; continue; } // Rust inclusive range
    // Leave operators glued to < > (generics like List<T>=, <=>, ->, etc. stay as written).
    if (op && !(op === "=" && /[<>!]/.test(code[i - 1] ?? "")) && !(op === "=>" && code[i - 1] === "=")) {
      out = out.replace(/[ \t]+$/, "");
      const atStart = out.trim() === "";
      out += (atStart ? "" : " ") + op;
      i += op.length;
      while (code[i] === " " || code[i] === "\t") i++;
      if (i < code.length || !isLast) out += " ";
      continue;
    }
    out += code[i];
    i++;
  }
  return out;
}

const KEYWORD_PAREN = /\b(if|for|foreach|while|switch|catch|when|elseif|using|lock)\(/g;

function spaceCode(code: string, L: Lang, parenDepthAtStart: number, segIndex: number, isLast: boolean): string {
  let c = code;
  c = c.replace(/,(?=[^\s,)\]}])/g, ", ");
  if (!isLast) c = c.replace(/,$/, ", "); // a string follows
  if (L.style === "braces") {
    c = c.replace(KEYWORD_PAREN, "$1 (").replace(/\)\{/g, ") {").replace(/\}(else|catch|finally)\b/g, "} $1").replace(/\b(else|try|finally|do)\{/g, "$1 {");
    // for (a;b;c) -> for (a; b; c)
    let depth = parenDepthAtStart;
    let out = "";
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      out += ch;
      if (ch === ";" && depth > 0 && c[i + 1] && !/[\s;)]/.test(c[i + 1])) out += " ";
    }
    c = out;
    if (L.operatorSpacing) c = spaceOperators(c, isLast);
  }
  // Never let spacing add leading whitespace to a segment that continues a line.
  return segIndex === 0 ? c.replace(/^\s+/, "") : c;
}

// ── Shared helpers ──────────────────────────────────────────────────────────
type LineInfo = { raw: string; segs: Seg[]; startState: ScanState; endState: ScanState };

function scanAll(lines: string[], L: Lang): LineInfo[] {
  let st: ScanState = { mode: "code" };
  return lines.map((raw) => {
    const startState = st;
    const r = scanLine(raw, st, L);
    st = r.state;
    return { raw, segs: r.segs, startState, endState: st };
  });
}

/** A line whose start is inside a multi-line string must keep every byte. */
const insideString = (l: LineInfo) => l.startState.mode === "str";

function joinSegs(segs: Seg[], L: Lang, parenDepthAtStart: number): string {
  let depth = parenDepthAtStart;
  return segs
    .map((s, idx) => {
      if (s.kind !== "code") return s.text;
      const spaced = spaceCode(s.text, L, depth, idx, idx === segs.length - 1);
      for (const ch of s.text) {
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
      }
      return spaced;
    })
    .join("");
}

/** Trailing spaces off, at most `maxBlank` blank lines in a row, none at the start, one newline at the end. */
function tidyBlankLines(lines: { text: string; locked: boolean }[], maxBlank: number): string {
  const out: string[] = [];
  let blanks = 0;
  for (const { text, locked } of lines) {
    if (locked) { out.push(text); blanks = 0; continue; }
    const t = text.replace(/[ \t]+$/, "");
    if (t === "") {
      if (out.length === 0 || blanks >= maxBlank) continue;
      blanks++;
      out.push("");
    } else {
      blanks = 0;
      out.push(t);
    }
  }
  while (out.length && out[out.length - 1] === "" ) out.pop();
  return out.join("\n") + "\n";
}

// ── Styles ──────────────────────────────────────────────────────────────────
const OPENERS = "{[(";
/** Lines that open a block with a trailing { (Go/Swift/Rust `if x {`, `class Main {`). */
const BLOCK_LINE = /^((public|private|protected|internal|static|abstract|final|sealed|open|data|export|pub|async|unsafe)\s+)*(if|else|for|while|switch|match|loop|select|class|interface|enum|struct|impl|trait|object|namespace|contract|library|record|func|fn|fun|extension|protocol|mod)\b/;
const CLOSERS = "}])";

function formatBraces(lines: LineInfo[], L: Lang): string {
  let depth = 0;
  let paren = 0;
  // Depths at which we are inside a `case x:` body (one extra indent level).
  const caseBodies = new Set<number>();
  const out: { text: string; locked: boolean }[] = [];
  for (const l of lines) {
    if (insideString(l)) {
      out.push({ text: l.raw, locked: true });
      // Brackets in the rest of the line after the string closes still count.
      for (const s of l.segs) if (s.kind === "code") for (const ch of s.text) {
        if (OPENERS.includes(ch)) depth++;
        else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
      }
      continue;
    }
    const trimmedSegs = l.segs.map((s) => ({ ...s }));
    if (trimmedSegs[0]?.kind === "code") trimmedSegs[0].text = trimmedSegs[0].text.replace(/^\s+/, "");
    const inBlockComment = l.startState.mode === "block";
    const code = codeOnly(trimmedSegs).trim();
    let text = joinSegs(trimmedSegs, L, paren).replace(/[ \t]+$/, "");
    if (BLOCK_LINE.test(code)) text = text.replace(/([^\s{])\{$/, "$1 {");

    let leading = 0;
    for (const ch of code) {
      if (CLOSERS.includes(ch)) leading++;
      else break;
    }
    // Leaving a block ends any case body opened inside it.
    for (const d of [...caseBodies]) if (d > depth - leading) caseBodies.delete(d);
    const isCaseLabel = /^(case\b[^;]*|default\s*):(?!:)/.test(code) && !code.includes("->");
    if (isCaseLabel) caseBodies.delete(depth);

    let level = depth - leading;
    if (!isCaseLabel && caseBodies.has(depth) && leading === 0 && !L.caseOutdent) level++;
    if (isCaseLabel && L.caseOutdent) level--;
    if (L.preprocessor && code.startsWith("#")) level = 0;
    level = Math.max(0, level);

    if (text === "") out.push({ text: "", locked: false });
    else if (inBlockComment) {
      const body = l.raw.trim();
      out.push({ text: L.indent.repeat(level) + (body.startsWith("*") ? " " : "") + body, locked: false });
    } else out.push({ text: L.indent.repeat(level) + text, locked: false });

    if (isCaseLabel) caseBodies.add(depth);
    for (const ch of code) {
      if (OPENERS.includes(ch)) depth++;
      else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === "(") paren++;
      else if (ch === ")") paren = Math.max(0, paren - 1);
    }
  }
  return tidyBlankLines(out, 1);
}

function bracketDelta(code: string) {
  let delta = 0;
  let leading = 0;
  let seenOther = false;
  for (const ch of code) {
    if (OPENERS.includes(ch)) { delta++; seenOther = true; }
    else if (CLOSERS.includes(ch)) { delta--; if (!seenOther) leading++; }
    else if (!/\s/.test(ch)) seenOther = true;
  }
  return { delta, leading };
}

function formatEnd(lines: LineInfo[], L: Lang): string {
  let depth = 0;
  const out: { text: string; locked: boolean }[] = [];
  for (const l of lines) {
    if (insideString(l) || l.startState.mode === "block") {
      out.push({ text: l.raw, locked: true });
      continue;
    }
    const code = codeOnly(l.segs).trim();
    const text = l.segs.map((s) => s.text).join("").trim();
    const b = L.blocks!(code);
    const br = bracketDelta(code);
    const level = Math.max(0, depth - (b.leadingClose || b.middle ? 1 : 0) - br.leading);
    out.push({ text: text ? L.indent.repeat(level) + text : "", locked: false });
    depth = Math.max(0, depth + b.opens - b.closes + br.delta);
  }
  return tidyBlankLines(out, 1);
}

function formatShell(lines: LineInfo[], L: Lang): string {
  let depth = 0;
  const out: { text: string; locked: boolean }[] = [];
  for (const l of lines) {
    if (insideString(l)) {
      out.push({ text: l.raw, locked: true });
      continue;
    }
    const code = codeOnly(l.segs).trim();
    const text = l.segs.map((s) => s.text).join("").trim();
    const words = code.replace(/[;&|]/g, " ").split(/\s+/);
    const leadingClose = /^(fi|done|esac|\})(\s|;|$)/.test(code);
    const middle = /^(else|elif)\b/.test(code);
    let opens = 0;
    let closes = 0;
    words.forEach((w) => {
      if (w === "then" || w === "do" || w === "{") opens++;
      if (w === "fi" || w === "done" || w === "esac" || w === "}") closes++;
    });
    if (/^case\b.*\bin$/.test(code)) opens++;
    // `elif x; then` continues the open if-block rather than opening a new one.
    if (/^elif\b/.test(code) && words.includes("then")) opens--;
    const level = Math.max(0, depth - (leadingClose || middle ? 1 : 0));
    out.push({ text: text ? L.indent.repeat(level) + text : "", locked: false });
    depth = Math.max(0, depth + opens - closes);
  }
  return tidyBlankLines(out, 1);
}

function formatLisp(lines: LineInfo[], L: Lang): string {
  let depth = 0;
  const out: { text: string; locked: boolean }[] = [];
  for (const l of lines) {
    if (insideString(l) || l.startState.mode === "block") {
      out.push({ text: l.raw, locked: true });
    } else {
      const code = codeOnly(l.segs).trim();
      const text = l.segs.map((s) => s.text).join("").trim();
      const level = Math.max(0, depth - bracketDelta(code).leading);
      out.push({ text: text ? L.indent.repeat(level) + text : "", locked: false });
    }
    for (const s of l.segs) if (s.kind === "code") for (let i = 0; i < s.text.length; i++) {
      const ch = s.text[i];
      if (ch === "\\") { i++; continue; }
      if (OPENERS.includes(ch)) depth++;
      else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
    }
  }
  return tidyBlankLines(out, 1);
}

function formatPlain(lines: LineInfo[]): string {
  return tidyBlankLines(
    lines.map((l) => (insideString(l) ? { text: l.raw, locked: true } : { text: l.raw.replace(/^\t+/, (t) => SP4.repeat(t.length)), locked: false })),
    2
  );
}

// Python ----------------------------------------------------------------------
function pythonSpacing(segs: Seg[], depthAtStart: number): string {
  let depth = depthAtStart;
  const parts: string[] = [];
  segs.forEach((s, idx) => {
    if (s.kind === "str") { parts.push(s.text); return; }
    if (s.kind === "comment") {
      // "#comment" -> "# comment"; inline comments get two spaces before them. Shebangs and #: stay.
      const c = /^#[^\s!:#]/.test(s.text) && !(idx === 0 && /^#!/.test(s.text)) ? "# " + s.text.slice(1) : s.text;
      const before = parts.join("");
      if (before.trim() !== "") {
        parts.length = 0;
        parts.push(before.replace(/[ \t]+$/, "") + "  ");
      }
      parts.push(c);
      return;
    }
    const notLast = idx < segs.length - 1; // a string or comment follows this code
    let code = s.text.replace(/,(?=[^\s,)\]}])/g, ", ");
    if (notLast) code = code.replace(/,$/, ", ");
    // Operators only outside brackets: inside them `=` is usually a keyword argument (f(a=1)).
    let out = "";
    let i = 0;
    while (i < code.length) {
      const ch = code[i];
      if (OPENERS.includes(ch)) depth++;
      else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
      if (depth === 0 && !OPENERS.includes(ch) && !CLOSERS.includes(ch)) {
        const op = ["**=", "//=", ">>=", "<<=", "<<", ">>", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", ":=", "->", "=", "<", ">"].find((o) => code.startsWith(o, i));
        if (op === "<<" || op === ">>") { out += op; i += 2; continue; } // shifts: leave as written
        if (op && !(op === "=" && /[<>!=]/.test(code[i - 1] ?? ""))) {
          out = out.replace(/[ \t]+$/, "");
          out += (out.trim() === "" && idx === 0 ? "" : " ") + op;
          i += op.length;
          while (code[i] === " " || code[i] === "\t") i++;
          if (i < code.length || notLast) out += " ";
          continue;
        }
      }
      out += ch;
      i++;
    }
    code = out;
    parts.push(idx === 0 ? code.replace(/^\s+/, "") : code);
  });
  return parts.join("").replace(/[ \t]+$/, "");
}

function formatPython(lines: LineInfo[], L: Lang): string {
  // Map each distinct indentation width to a level (a stack, like the tokenizer does).
  const stack: number[] = [0];
  let bracket = 0;
  let stmtShift = 0; // continuation lines move by the same amount as their statement's first line
  const out: { text: string; locked: boolean; level: number; code: string }[] = [];
  for (const l of lines) {
    if (insideString(l)) {
      out.push({ text: l.raw, locked: true, level: -1, code: "" });
      continue;
    }
    const expanded = l.raw.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, SP4));
    const width = expanded.length - expanded.trimStart().length;
    const body = expanded.trimStart();
    const code = codeOnly(l.segs).trim();
    if (body === "") {
      out.push({ text: "", locked: false, level: -1, code: "" });
      continue;
    }
    let text: string;
    let level = -1;
    if (bracket > 0) {
      text = " ".repeat(Math.max(0, width + stmtShift)) + pythonSpacing([{ kind: "code", text: "" }, ...l.segs.map((s, i) => (i === 0 && s.kind === "code" ? { ...s, text: s.text.replace(/^\s+/, "") } : s))], bracket);
    } else if (code === "") {
      // Comment-only line: indent like the code around it.
      while (stack.length > 1 && width < stack[stack.length - 1]) stack.pop();
      level = width > stack[stack.length - 1] ? stack.length : stack.length - 1;
      text = L.indent.repeat(level) + body;
      level = -2; // comments don't drive blank-line rules
    } else {
      while (stack.length > 1 && width < stack[stack.length - 1]) stack.pop();
      if (width > stack[stack.length - 1]) stack.push(width);
      level = stack.length - 1;
      stmtShift = level * 4 - width;
      text = L.indent.repeat(level) + pythonSpacing(l.segs, 0);
    }
    out.push({ text, locked: false, level, code });
    for (const ch of code) {
      if (OPENERS.includes(ch)) bracket++;
      else if (CLOSERS.includes(ch)) bracket = Math.max(0, bracket - 1);
    }
  }

  // PEP 8 blank lines: two around top-level def/class (and their decorators), at most one inside.
  const final: { text: string; locked: boolean }[] = [];
  let prevCodeLevel = -1;
  let prevWasDecorator = false;
  let seenCode = false;
  let pendingBlank = 0;
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    if (o.locked) { flushBlank(); final.push(o); continue; }
    if (o.text === "") { pendingBlank++; continue; }
    const topDef = o.level === 0 && /^(async\s+def|def|class)\b|^@/.test(o.code);
    const afterTopBlock = o.level === 0 && prevCodeLevel > 0;
    if (seenCode && topDef && !prevWasDecorator) pendingBlank = 2;
    else if (seenCode && afterTopBlock && !/^(else|elif|except|finally)\b/.test(o.code)) pendingBlank = Math.max(pendingBlank, 2);
    else if (o.level > 0 && /^(async\s+def|def|class)\b|^@/.test(o.code) && prevCodeLevel >= o.level && !prevWasDecorator) pendingBlank = 1;
    else if (o.level > 0 || o.level === -1) pendingBlank = Math.min(pendingBlank, 1);
    else pendingBlank = Math.min(pendingBlank, 2);
    flushBlank();
    final.push({ text: o.text, locked: false });
    if (o.level >= 0) {
      seenCode = true;
      prevCodeLevel = o.level;
      prevWasDecorator = /^@/.test(o.code);
    }
  }
  return tidyBlankLines(final, 2);

  function flushBlank() {
    if (final.length > 0) for (let k = 0; k < pendingBlank; k++) final.push({ text: "", locked: false });
    pendingBlank = 0;
  }
}

// SQL -------------------------------------------------------------------------
const SQL_CLAUSES = [
  "SELECT DISTINCT", "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET",
  "UNION ALL", "UNION", "INTERSECT", "EXCEPT", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM",
  "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "JOIN",
  "RETURNING", "ON CONFLICT", "WITH",
];
const SQL_KEYWORDS = new Set(
  ("select distinct from where group by order having limit offset union all intersect except insert into values update set delete " +
    "left right full outer inner cross join on and or not in is null like between as asc desc case when then else end " +
    "create table view index primary key foreign references unique default check drop alter add column if exists " +
    "integer int text varchar char boolean real float double decimal numeric date timestamp serial bigint smallint " +
    "count sum avg min max coalesce returning conflict do nothing with begin commit rollback transaction true false").split(" ")
);

function formatSql(src: string, L: Lang): string {
  const lines = scanAll(src.split("\n"), L);
  // Rebuild as a token stream: code words / strings / comments, then lay it out again.
  type Tok = { kind: Seg["kind"] | "nl"; text: string };
  const toks: Tok[] = [];
  lines.forEach((l, li) => {
    l.segs.forEach((s) => toks.push(s));
    if (li < lines.length - 1) toks.push({ kind: l.endState.mode === "code" ? "nl" : "str", text: "\n" });
  });
  let flat = "";
  for (const t of toks) {
    if (t.kind === "code") flat += t.text.replace(/\s+/g, " ").replace(/\b[A-Za-z_]+\b/g, (w) => (SQL_KEYWORDS.has(w.toLowerCase()) ? w.toUpperCase() : w));
    else if (t.kind === "comment") flat += (t.text.startsWith("--") ? "\u0000" : "") + t.text + (t.text.startsWith("--") ? "\u0001" : "");
    else if (t.kind === "nl") flat += " ";
    else flat += t.text;
  }
  // Clause keywords start a new line; AND/OR inside WHERE get their own indented line.
  let depth = 0;
  let out = "";
  let i = 0;
  let inStr: string | null = null;
  while (i < flat.length) {
    const ch = flat[i];
    if (inStr) {
      out += ch;
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = ch; out += ch; i++; continue; }
    if (ch === "\u0000") { out = out.replace(/ +$/, "") + (out && !out.endsWith("\n") ? "\n" : ""); i++; continue; }
    if (ch === "\u0001") { out += "\n"; i++; while (flat[i] === " ") i++; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";") {
      out = out.replace(/ +$/, "") + ";\n\n";
      i++;
      while (flat[i] === " ") i++;
      continue;
    }
    const atWord = !/[A-Za-z0-9_]/.test(flat[i - 1] ?? " ");
    if (atWord && depth === 0) {
      const clause = SQL_CLAUSES.find((c) => flat.startsWith(c, i) && !/[A-Za-z0-9_]/.test(flat[i + c.length] ?? " "));
      if (clause) {
        out = out.replace(/ +$/, "");
        if (out && !out.endsWith("\n")) out += "\n";
        out += clause;
        i += clause.length;
        continue;
      }
      const bool = ["AND", "OR"].find((c) => flat.startsWith(c, i) && !/[A-Za-z0-9_]/.test(flat[i + c.length] ?? " "));
      if (bool && !/BETWEEN \S+ $/.test(out)) {
        out = out.replace(/ +$/, "") + "\n" + L.indent + bool;
        i += bool.length;
        continue;
      }
    }
    if (ch === " " && (out.endsWith("\n") || out === "")) { i++; continue; }
    out += ch;
    i++;
  }
  return tidyBlankLines(out.split("\n").map((t) => ({ text: t, locked: false })), 1);
}

// ── Entry point ─────────────────────────────────────────────────────────────
/** Formats `code` written in the Monaco language `monacoId`. Unknown languages get whitespace clean-up only. */
export function formatCode(code: string, monacoId: string): string {
  const L = LANGS[monacoId] ?? LANGS.fsharp;
  const src = code.replace(/\r\n?/g, "\n");
  if (src.trim() === "") return "";
  if (L.style === "sql") return formatSql(src, L);
  const lines = scanAll(src.split("\n"), L);
  switch (L.style) {
    case "braces": return formatBraces(lines, L);
    case "end": return formatEnd(lines, L);
    case "shell": return formatShell(lines, L);
    case "lisp": return formatLisp(lines, L);
    case "python": return formatPython(lines, L);
    default: return formatPlain(lines);
  }
}

export type TextEdit = { start: number; end: number; text: string };

/**
 * Small edits (character offsets into `before`) that turn `before` into `after`, so
 * collaborators' cursors and their typing elsewhere in the file are disturbed as little
 * as possible. Re-indentation (same number of lines) becomes one edit per changed line.
 */
export function textEdits(before: string, after: string): TextEdit[] {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length === b.length) {
    const edits: TextEdit[] = [];
    let offset = 0;
    a.forEach((line, k) => {
      if (line !== b[k]) edits.push({ start: offset, end: offset + line.length, text: b[k] });
      offset += line.length + 1;
    });
    return edits;
  }
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return [{ start: p, end: before.length - s, text: after.slice(p, after.length - s) }];
}

/** Applies textEdits (used by tests; the editor applies them through Monaco). */
export function applyEdits(before: string, edits: TextEdit[]): string {
  return [...edits].sort((x, y) => y.start - x.start).reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), before);
}
