"""
Languages the AI fix loop supports: each is runnable in the sandbox (the fix is tested
there) and has a tree-sitter grammar to locate the target function.

Keep in sync with services/worker/src/sandbox/languages.ts (file + interpreter),
services/api/src/lib/languages.ts and apps/web/src/lib/languages.ts
(tests/test-languages.ts checks they agree).
"""

from typing import Dict, List, Optional, Tuple

# id -> (default file name, interpreter argv WITHOUT the file)
AI_LANGUAGES: Dict[str, Tuple[str, List[str]]] = {
    "python": ("main.py", ["python3"]),
    "javascript": ("index.js", ["node"]),
    "typescript": ("main.ts", ["node", "--experimental-transform-types", "--no-warnings"]),
    "java": ("Main.java", ["java", "-Xmx128m", "-Xss512k", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-XX:CICompilerCount=1", "-Xshare:auto"]),
    "ruby": ("main.rb", ["ruby"]),
    "php": ("main.php", ["php", "-d", "display_errors=stderr"]),
    "perl": ("main.pl", ["perl"]),
    "lua": ("main.lua", ["lua5.4"]),
    "bash": ("main.sh", ["bash"]),
}

# tree-sitter node types that define a named function/method, per grammar.
FUNCTION_NODE_TYPES: Dict[str, Tuple[str, ...]] = {
    "python": ("function_definition",),
    "javascript": ("function_declaration", "method_definition"),
    "typescript": ("function_declaration", "method_definition"),
    "java": ("method_declaration", "constructor_declaration"),
    "ruby": ("method", "singleton_method"),
    "php": ("function_definition", "method_declaration"),
    "perl": ("function_definition",),
    "lua": ("function_definition_statement", "local_function_definition_statement"),
    "bash": ("function_definition",),
}

_ALIASES = {"py": "python", "js": "javascript", "jsx": "javascript", "ts": "typescript", "tsx": "typescript", "sh": "bash"}


def normalize(language: str) -> str:
    lang = (language or "").lower()
    return _ALIASES.get(lang, lang)


def default_command(language: str, filename: str) -> List[str]:
    """How the sandbox runs `filename` for this language (no test command given)."""
    spec = AI_LANGUAGES.get(normalize(language))
    argv = spec[1] if spec else ["python3"]
    return [*argv, filename]


def default_filename(language: str) -> Optional[str]:
    spec = AI_LANGUAGES.get(normalize(language))
    return spec[0] if spec else None
