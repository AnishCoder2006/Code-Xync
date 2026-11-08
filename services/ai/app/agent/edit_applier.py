"""
Edit Applier for CodeSync Phase 5.
Replaces a named function/method in source code using tree-sitter AST ranges,
preserving surrounding code and formatting. Generates a unified diff.
Handles:
- Top-level and nested functions
- Decorated functions (Python)
- Methods inside classes
- Files with syntax errors (tree-sitter error recovery + regex fallback)
"""

import os
import re
import difflib
from dataclasses import dataclass
from typing import Optional, Tuple, Dict, Any
import tree_sitter_languages

from app.rag.chunker import _get_parser


@dataclass
class ApplyResult:
    patched_content: str
    diff_patch: str
    function_name: str
    original_code: str
    new_code: str
    start_line: int
    end_line: int
    start_byte: int
    end_byte: int


def find_function_range(
    content: str,
    function_name: str,
    language: str = "python",
) -> Tuple[int, int, int, int, str]:
    """
    Locate start_byte, end_byte, start_line, end_line, and original_code for function_name.
    Uses tree-sitter AST traversal; falls back to regex if tree-sitter does not match.
    Returns (start_byte, end_byte, start_line, end_line, original_code).
    Raises ValueError if function cannot be found.
    """
    content_bytes = content.encode("utf-8")
    parser, norm_lang = _get_parser(language)

    target_node = None
    target_orig_text = ""

    if parser:
        try:
            tree = parser.parse(content_bytes)
            root = tree.root_node

            def search_node(node):
                nonlocal target_node
                if target_node is not None:
                    return

                # Python decorated definition: check child function/class name
                if norm_lang == "python" and node.type == "decorated_definition":
                    for child in node.children:
                        if child.type in ("function_definition", "class_definition"):
                            name_child = child.child_by_field_name("name")
                            if name_child and name_child.text.decode("utf-8") == function_name:
                                target_node = node  # include decorators in replacement
                                return

                # Standard function / method definition
                if node.type in ("function_definition", "function_declaration", "method_definition"):
                    name_child = node.child_by_field_name("name")
                    if name_child and name_child.text.decode("utf-8") == function_name:
                        # If wrapped by decorated_definition, prefer outer
                        if node.parent and node.parent.type == "decorated_definition":
                            target_node = node.parent
                        else:
                            target_node = node
                        return

                # TypeScript / JS variable declarator with arrow function
                if node.type in ("variable_declarator", "lexical_declaration"):
                    name_child = node.child_by_field_name("name")
                    if name_child and name_child.text.decode("utf-8") == function_name:
                        target_node = node
                        return

                for c in node.children:
                    search_node(c)

            search_node(root)
        except Exception:
            target_node = None

    if target_node is not None:
        start_byte = target_node.start_byte
        end_byte = target_node.end_byte
        start_line = target_node.start_point[0] + 1
        end_line = target_node.end_point[0] + 1
        original_code = content_bytes[start_byte:end_byte].decode("utf-8", errors="replace")
        return start_byte, end_byte, start_line, end_line, original_code

    # Fallback: regex search if tree-sitter did not find it or file is severely broken
    lines = content.splitlines(keepends=True)
    fn_pattern = re.compile(rf"^\s*(def|async\s+def|function)\s+{re.escape(function_name)}\b")
    match_start_line = None
    for idx, line in enumerate(lines):
        if fn_pattern.search(line):
            match_start_line = idx
            break

    if match_start_line is not None:
        # Determine indentation of the function definition
        start_indent = len(lines[match_start_line]) - len(lines[match_start_line].lstrip())
        # Check for preceding decorator lines in Python
        actual_start_line = match_start_line
        if norm_lang == "python":
            while actual_start_line > 0 and lines[actual_start_line - 1].strip().startswith("@"):
                actual_start_line -= 1

        # Scan forward for function end (next line with indentation <= start_indent)
        end_idx = match_start_line + 1
        for i in range(match_start_line + 1, len(lines)):
            line = lines[i]
            if not line.strip():  # blank lines can be inside function
                continue
            curr_indent = len(line) - len(line.lstrip())
            if curr_indent <= start_indent:
                end_idx = i
                break
            end_idx = i + 1

        prefix = "".join(lines[:actual_start_line])
        matched_str = "".join(lines[actual_start_line:end_idx])
        start_byte = len(prefix.encode("utf-8"))
        end_byte = start_byte + len(matched_str.encode("utf-8"))
        start_line = actual_start_line + 1
        end_line = end_idx
        return start_byte, end_byte, start_line, end_line, matched_str.rstrip("\r\n")

    raise ValueError(f"Function '{function_name}' not found in source code")


def apply_function_edit(
    file_content: str,
    function_name: str,
    new_code: str,
    file_path: str = "main.py",
    language: str = "python",
) -> ApplyResult:
    """
    Replace function_name with new_code in file_content using tree-sitter AST ranges.
    Returns ApplyResult with patched_content and unified diff_patch.
    """
    clean_new_code = new_code.strip()
    start_byte, end_byte, start_line, end_line, orig_code = find_function_range(
        file_content, function_name, language
    )

    content_bytes = file_content.encode("utf-8")
    new_bytes = clean_new_code.encode("utf-8")

    # Reconstruct text replacing only the target byte span
    patched_bytes = content_bytes[:start_byte] + new_bytes + content_bytes[end_byte:]
    patched_content = patched_bytes.decode("utf-8", errors="replace")

    # Generate unified diff
    orig_lines = file_content.splitlines(keepends=True)
    patched_lines = patched_content.splitlines(keepends=True)

    diff = difflib.unified_diff(
        orig_lines,
        patched_lines,
        fromfile=f"a/{file_path}",
        tofile=f"b/{file_path}",
    )
    diff_patch = "".join(diff)

    return ApplyResult(
        patched_content=patched_content,
        diff_patch=diff_patch,
        function_name=function_name,
        original_code=orig_code,
        new_code=clean_new_code,
        start_line=start_line,
        end_line=end_line,
        start_byte=start_byte,
        end_byte=start_byte + len(new_bytes),
    )
