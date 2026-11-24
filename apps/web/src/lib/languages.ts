/**
 * Every room language. `run` = sandbox image exists (worker), so Run works and AI fixes are
 * tested there. Edit-only languages get live collaboration + syntax highlighting.
 * Keep in sync with services/api/src/lib/languages.ts, services/worker/src/sandbox/languages.ts
 * and services/ai/app/agent/languages.py (tests/test-languages.ts checks they agree).
 */
export type LanguageInfo = {
  id: string;
  label: string;
  /** Monaco language id (syntax highlighting). */
  monaco: string;
  file: string;
  /** Sandbox Run + AI fix available. */
  run: boolean;
  /** Dot colour on cards (the language's usual brand colour). */
  color: string;
};

export const LANGUAGES: LanguageInfo[] = [
  // Runnable (sandbox image) — also AI fix
  { id: "python", label: "Python", monaco: "python", file: "main.py", run: true, color: "#3776ab" },
  { id: "javascript", label: "JavaScript", monaco: "javascript", file: "index.js", run: true, color: "#e5b400" },
  { id: "typescript", label: "TypeScript", monaco: "typescript", file: "main.ts", run: true, color: "#3178c6" },
  { id: "java", label: "Java", monaco: "java", file: "Main.java", run: true, color: "#e76f00" },
  { id: "ruby", label: "Ruby", monaco: "ruby", file: "main.rb", run: true, color: "#cc342d" },
  { id: "php", label: "PHP", monaco: "php", file: "main.php", run: true, color: "#777bb4" },
  { id: "perl", label: "Perl", monaco: "perl", file: "main.pl", run: true, color: "#39457e" },
  { id: "lua", label: "Lua", monaco: "lua", file: "main.lua", run: true, color: "#000080" },
  { id: "bash", label: "Bash", monaco: "shell", file: "main.sh", run: true, color: "#4eaa25" },
  // Edit only
  { id: "c", label: "C", monaco: "c", file: "main.c", run: false, color: "#a8b9cc" },
  { id: "cpp", label: "C++", monaco: "cpp", file: "main.cpp", run: false, color: "#00599c" },
  { id: "csharp", label: "C#", monaco: "csharp", file: "Program.cs", run: false, color: "#68217a" },
  { id: "go", label: "Go", monaco: "go", file: "main.go", run: false, color: "#00add8" },
  { id: "rust", label: "Rust", monaco: "rust", file: "main.rs", run: false, color: "#ce422b" },
  { id: "kotlin", label: "Kotlin", monaco: "kotlin", file: "Main.kt", run: false, color: "#7f52ff" },
  { id: "swift", label: "Swift", monaco: "swift", file: "main.swift", run: false, color: "#f05138" },
  { id: "scala", label: "Scala", monaco: "scala", file: "Main.scala", run: false, color: "#dc322f" },
  { id: "dart", label: "Dart", monaco: "dart", file: "main.dart", run: false, color: "#0175c2" },
  { id: "r", label: "R", monaco: "r", file: "main.R", run: false, color: "#276dc3" },
  { id: "julia", label: "Julia", monaco: "julia", file: "main.jl", run: false, color: "#9558b2" },
  { id: "elixir", label: "Elixir", monaco: "elixir", file: "main.exs", run: false, color: "#6e4a7e" },
  { id: "clojure", label: "Clojure", monaco: "clojure", file: "main.clj", run: false, color: "#5881d8" },
  { id: "fsharp", label: "F#", monaco: "fsharp", file: "Program.fs", run: false, color: "#378bba" },
  { id: "objective-c", label: "Objective-C", monaco: "objective-c", file: "main.m", run: false, color: "#438eff" },
  { id: "pascal", label: "Pascal", monaco: "pascal", file: "main.pas", run: false, color: "#e3f171" },
  { id: "scheme", label: "Scheme", monaco: "scheme", file: "main.scm", run: false, color: "#1e4aec" },
  { id: "vb", label: "Visual Basic", monaco: "vb", file: "Program.vb", run: false, color: "#945db7" },
  { id: "powershell", label: "PowerShell", monaco: "powershell", file: "main.ps1", run: false, color: "#012456" },
  { id: "coffeescript", label: "CoffeeScript", monaco: "coffeescript", file: "main.coffee", run: false, color: "#244776" },
  { id: "solidity", label: "Solidity", monaco: "sol", file: "Contract.sol", run: false, color: "#363636" },
  { id: "sql", label: "SQL", monaco: "sql", file: "query.sql", run: false, color: "#e38c00" },
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));
const FALLBACK = (id: string): LanguageInfo => ({ id, label: id, monaco: "plaintext", file: "main.txt", run: false, color: "#888888" });

export const languageInfo = (id: string): LanguageInfo => BY_ID.get(id) ?? FALLBACK(id);
export const RUNNABLE = LANGUAGES.filter((l) => l.run);
export const EDIT_ONLY = LANGUAGES.filter((l) => !l.run);
/** Short extension for card tiles: ".py", ".java", ... */
export const extOf = (id: string) => "." + (languageInfo(id).file.split(".").pop() ?? "txt");
