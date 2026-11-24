/**
 * Room languages the API accepts. RUNNABLE ones have a sandbox image in the worker
 * (services/worker/src/sandbox/languages.ts); AI fixes need a runnable language (the fix
 * is tested in the sandbox) with a parser in the AI service. Everything else is
 * edit-only: collaborative editing with syntax highlighting, no Run, no AI fix.
 *
 * Keep in sync with apps/web/src/lib/languages.ts, the worker and
 * services/ai/app/agent/languages.py (tests/test-languages.ts checks they agree).
 */
export const RUNNABLE_LANGUAGES = [
  "python", "javascript", "typescript", "java", "ruby", "php", "perl", "lua", "bash",
] as const;

export const AI_FIX_LANGUAGES = RUNNABLE_LANGUAGES;

export const EDIT_ONLY_LANGUAGES = [
  "c", "cpp", "csharp", "go", "rust", "kotlin", "swift", "scala", "dart", "r", "julia",
  "elixir", "clojure", "fsharp", "objective-c", "pascal", "scheme", "vb", "powershell",
  "coffeescript", "solidity", "sql",
] as const;

export const ROOM_LANGUAGES: readonly string[] = [...RUNNABLE_LANGUAGES, ...EDIT_ONLY_LANGUAGES];

export const isRoomLanguage = (l: unknown): l is string => typeof l === "string" && ROOM_LANGUAGES.includes(l);
export const isRunnable = (l: unknown) => typeof l === "string" && (RUNNABLE_LANGUAGES as readonly string[]).includes(l);
export const isAiFixable = (l: unknown) => typeof l === "string" && (AI_FIX_LANGUAGES as readonly string[]).includes(l);
