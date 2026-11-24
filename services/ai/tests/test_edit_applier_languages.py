"""
AI fix loop, language-specific part: locate a named function and replace only it, in
every AI language (services/ai/app/agent/languages.py). The patched file must still
parse without errors and keep the surrounding code byte-for-byte.
"""

import pytest
import tree_sitter_languages

from app.agent.edit_applier import apply_function_edit, find_function_range
from app.agent.languages import AI_LANGUAGES, FUNCTION_NODE_TYPES

CASES = {
    "java": (
        "public class Main {\n  static int add(int a, int b) {\n    return a - b;\n  }\n\n"
        "  public static void main(String[] x) {\n    System.out.println(add(1, 2));\n  }\n}\n",
        "static int add(int a, int b) {\n    return a + b;\n  }",
        "return a - b;",
    ),
    "ruby": (
        "def add(a, b)\n  a - b\nend\n\nputs add(1, 2)\n",
        "def add(a, b)\n  a + b\nend",
        "a - b",
    ),
    "php": (
        "<?php\nfunction add($a, $b) {\n  return $a - $b;\n}\n\necho add(1, 2), \"\\n\";\n",
        "function add($a, $b) {\n  return $a + $b;\n}",
        "return $a - $b;",
    ),
    "perl": (
        "use strict;\nsub add {\n  my ($a, $b) = @_;\n  return $a - $b;\n}\n\nprint add(1, 2), \"\\n\";\n",
        "sub add {\n  my ($a, $b) = @_;\n  return $a + $b;\n}",
        "return $a - $b;",
    ),
    "lua": (
        "local function add(a, b)\n  return a - b\nend\n\nprint(add(1, 2))\n",
        "local function add(a, b)\n  return a + b\nend",
        "return a - b",
    ),
    "bash": (
        "add() {\n  echo $(( $1 - $2 ))\n}\n\nadd 1 2\n",
        "add() {\n  echo $(( $1 + $2 ))\n}",
        "$1 - $2",
    ),
    "typescript": (
        "function add(a: number, b: number): number {\n  return a - b;\n}\n\nconsole.log(add(1, 2));\n",
        "function add(a: number, b: number): number {\n  return a + b;\n}",
        "return a - b;",
    ),
    "javascript": (
        "function add(a, b) {\n  return a - b;\n}\n\nconsole.log(add(1, 2));\n",
        "function add(a, b) {\n  return a + b;\n}",
        "return a - b;",
    ),
    "python": (
        "def add(a, b):\n    return a - b\n\n\nprint(add(1, 2))\n",
        "def add(a, b):\n    return a + b",
        "return a - b",
    ),
}


def test_every_ai_language_has_a_case_and_node_types():
    assert set(CASES) == set(AI_LANGUAGES) == set(FUNCTION_NODE_TYPES)


@pytest.mark.parametrize("lang", sorted(CASES))
def test_locate_and_replace(lang):
    src, new_code, old_body = CASES[lang]
    filename = AI_LANGUAGES[lang][0]

    _, _, start_line, end_line, original = find_function_range(src, "add", lang)
    assert old_body in original, original
    assert start_line >= 1 and end_line >= start_line

    res = apply_function_edit(src, "add", new_code, file_path=filename, language=lang)
    assert old_body not in res.patched_content
    assert new_code in res.patched_content
    # Only the function changed: text before and after it is identical.
    before, after = src.split(original)
    assert res.patched_content == before + new_code + after
    assert f"--- a/{filename}" in res.diff_patch

    # The bundled Lua grammar gives nondeterministic error trees (see edit_applier), so the
    # Lua result is checked by the Lua cases below and by running it in the sandbox instead.
    if lang != "lua":
        tree = tree_sitter_languages.get_parser(lang).parse(res.patched_content.encode())
        assert not tree.root_node.has_error, res.patched_content


def test_qualified_lua_name_matches_last_part():
    src = "local M = {}\nfunction M.div(a, b)\n  return a * b\nend\nreturn M\n"
    _, _, _, _, original = find_function_range(src, "div", "lua")
    assert original.startswith("function M.div")


def test_missing_function_raises():
    with pytest.raises(ValueError):
        find_function_range("def other():\n  1\nend\n", "add", "ruby")


LUA_TRICKY = """local M = {}
-- function fake() end  (a comment that looks like code)
local function add(a, b)
  local s = "this string says end and function"
  local t = [[long string: end end end]]
  --[[ block comment: end ]]
  for i = 1, 2 do
    if a > b then
      repeat a = a - 1 until a <= b
    elseif a == b then
      while false do end
    end
  end
  return a - b
end

function M:scale(x)
  return x * 2
end

print(add(3, 1))
"""


def test_lua_block_matcher_handles_nesting_strings_comments():
    _, _, start_line, end_line, original = find_function_range(LUA_TRICKY, "add", "lua")
    assert original.startswith("local function add(a, b)")
    assert original.endswith("return a - b\nend")
    assert (start_line, end_line) == (3, 15)


def test_lua_method_with_colon():
    _, _, _, _, original = find_function_range(LUA_TRICKY, "scale", "lua")
    assert original == "function M:scale(x)\n  return x * 2\nend"


def test_lua_is_stable_across_repeated_calls():
    results = {find_function_range(LUA_TRICKY, "add", "lua")[4] for _ in range(50)}
    assert len(results) == 1
