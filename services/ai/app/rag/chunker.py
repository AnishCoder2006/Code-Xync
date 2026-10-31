"""
AST code chunker using tree-sitter.
Extracts whole functions, methods, classes, and interfaces as atomic units
for TypeScript/JavaScript and Python.
See design doc section 4.1.
"""

from dataclasses import dataclass, asdict
from typing import List, Optional
import hashlib
import logging
import os
import tree_sitter_languages

logger = logging.getLogger(__name__)

# Maximum file size in bytes for fallback chunks (100 KB)
MAX_FALLBACK_BYTES = 100 * 1024


@dataclass
class CodeChunk:
    text: str
    ast_type: str  # "function" | "method" | "class" | "interface" | "file"
    function_name: str
    language: str
    start_line: int
    end_line: int
    content_hash: str

    def to_dict(self):
        return asdict(self)


def compute_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _get_parser(language: str):
    lang_lower = language.lower()
    if lang_lower in ("python", "py"):
        return tree_sitter_languages.get_parser("python"), "python"
    elif lang_lower in ("typescript", "ts", "tsx"):
        return tree_sitter_languages.get_parser("typescript"), "typescript"
    elif lang_lower in ("javascript", "js", "jsx"):
        return tree_sitter_languages.get_parser("javascript"), "javascript"
    else:
        return None, lang_lower


def chunk_file(path: str, content: str, language: Optional[str] = None) -> List[CodeChunk]:
    """
    Parse a source code file and return AST-derived chunks.
    Falls back to a single file chunk if parsing fails or extracts 0 units.
    """
    if not language:
        ext = os.path.splitext(path)[1].lower()
        if ext in (".py",):
            language = "python"
        elif ext in (".ts", ".tsx"):
            language = "typescript"
        elif ext in (".js", ".jsx"):
            language = "javascript"
        else:
            language = "text"

    parser, normalized_lang = _get_parser(language)
    if not parser:
        logger.warning(f"No tree-sitter parser available for language '{language}' on file '{path}'. Using fallback chunk.")
        return [_create_fallback_chunk(path, content, language)]

    try:
        content_bytes = content.encode("utf-8")
        tree = parser.parse(content_bytes)

        if normalized_lang == "python":
            chunks = _extract_python_chunks(tree.root_node, content_bytes, normalized_lang)
        else:
            chunks = _extract_ts_js_chunks(tree.root_node, content_bytes, normalized_lang)

        if not chunks:
            logger.warning(f"No functions, classes, or interfaces extracted from '{path}'. Using single-file fallback chunk.")
            return [_create_fallback_chunk(path, content, normalized_lang)]

        return chunks
    except Exception as e:
        logger.warning(f"AST parsing failed for file '{path}': {e}. Using fallback chunk.")
        return [_create_fallback_chunk(path, content, normalized_lang)]


def _create_fallback_chunk(path: str, content: str, language: str) -> CodeChunk:
    capped_content = content[:MAX_FALLBACK_BYTES]
    lines = capped_content.splitlines()
    total_lines = len(lines) if lines else 1
    filename = os.path.basename(path)

    return CodeChunk(
        text=capped_content,
        ast_type="file",
        function_name=filename or "file",
        language=language,
        start_line=1,
        end_line=total_lines,
        content_hash=compute_sha256(capped_content),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Python AST Extraction
# ─────────────────────────────────────────────────────────────────────────────

def _extract_python_chunks(root_node, content_bytes: bytes, language: str) -> List[CodeChunk]:
    chunks: List[CodeChunk] = []

    def traverse(node, in_class: bool = False):
        node_type = node.type

        # Check for decorated definitions (e.g. @decorator def foo():)
        if node_type == "decorated_definition":
            # The definition child is inside the decorated definition
            inner_def = None
            for child in node.children:
                if child.type in ("function_definition", "class_definition"):
                    inner_def = child
                    break

            if inner_def:
                start_line = node.start_point[0] + 1
                end_line = node.end_point[0] + 1
                text = content_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")

                name_node = inner_def.child_by_field_name("name")
                name = name_node.text.decode("utf-8", errors="replace") if name_node else "anonymous"

                if inner_def.type == "class_definition":
                    ast_type = "class"
                    chunks.append(CodeChunk(
                        text=text,
                        ast_type=ast_type,
                        function_name=name,
                        language=language,
                        start_line=start_line,
                        end_line=end_line,
                        content_hash=compute_sha256(text),
                    ))
                    # Recurse inside class body for methods
                    body = inner_def.child_by_field_name("body")
                    if body:
                        for child in body.children:
                            traverse(child, in_class=True)
                else:
                    ast_type = "method" if in_class else "function"
                    chunks.append(CodeChunk(
                        text=text,
                        ast_type=ast_type,
                        function_name=name,
                        language=language,
                        start_line=start_line,
                        end_line=end_line,
                        content_hash=compute_sha256(text),
                    ))
                    # Recurse inside function body for nested functions
                    body = inner_def.child_by_field_name("body")
                    if body:
                        for child in body.children:
                            traverse(child, in_class=False)
                return

        # Plain function definition
        if node_type == "function_definition":
            # If already wrapped by decorated_definition, parent would have handled it
            if node.parent and node.parent.type == "decorated_definition":
                return

            name_node = node.child_by_field_name("name")
            name = name_node.text.decode("utf-8", errors="replace") if name_node else "anonymous"
            start_line = node.start_point[0] + 1
            end_line = node.end_point[0] + 1
            text = content_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
            ast_type = "method" if in_class else "function"

            chunks.append(CodeChunk(
                text=text,
                ast_type=ast_type,
                function_name=name,
                language=language,
                start_line=start_line,
                end_line=end_line,
                content_hash=compute_sha256(text),
            ))

            # Recurse for nested functions
            body = node.child_by_field_name("body")
            if body:
                for child in body.children:
                    traverse(child, in_class=False)
            return

        # Plain class definition
        if node_type == "class_definition":
            if node.parent and node.parent.type == "decorated_definition":
                return

            name_node = node.child_by_field_name("name")
            name = name_node.text.decode("utf-8", errors="replace") if name_node else "anonymous"
            start_line = node.start_point[0] + 1
            end_line = node.end_point[0] + 1
            text = content_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")

            chunks.append(CodeChunk(
                text=text,
                ast_type="class",
                function_name=name,
                language=language,
                start_line=start_line,
                end_line=end_line,
                content_hash=compute_sha256(text),
            ))

            # Recurse inside class body for methods
            body = node.child_by_field_name("body")
            if body:
                for child in body.children:
                    traverse(child, in_class=True)
            return

        # For any other node, traverse its children
        for child in node.children:
            traverse(child, in_class)

    traverse(root_node, in_class=False)
    return chunks


# ─────────────────────────────────────────────────────────────────────────────
# TypeScript / JavaScript AST Extraction
# ─────────────────────────────────────────────────────────────────────────────

def _extract_ts_js_chunks(root_node, content_bytes: bytes, language: str) -> List[CodeChunk]:
    chunks: List[CodeChunk] = []

    def traverse(node, in_class: bool = False):
        node_type = node.type

        # Unwrap export_statement if present
        actual_node = node
        is_exported = False
        if node_type == "export_statement":
            is_exported = True
            for child in node.children:
                if child.type in (
                    "function_declaration",
                    "class_declaration",
                    "interface_declaration",
                    "lexical_declaration",
                    "variable_declaration",
                ):
                    actual_node = child
                    node_type = child.type
                    break

        # 1. Function declaration
        if node_type == "function_declaration":
            name_node = actual_node.child_by_field_name("name")
            name = name_node.text.decode("utf-8", errors="replace") if name_node else "anonymous"
            target = node if is_exported else actual_node
            start_line = target.start_point[0] + 1
            end_line = target.end_point[0] + 1
            text = content_bytes[target.start_byte:target.end_byte].decode("utf-8", errors="replace")

            chunks.append(CodeChunk(
                text=text,
                ast_type="function",
                function_name=name,
                language=language,
                start_line=start_line,
                end_line=end_line,
                content_hash=compute_sha256(text),
            ))

            body = actual_node.child_by_field_name("body")
            if body:
                for child in body.children:
                    traverse(child, in_class=False)
            return

        # 2. Class declaration
        if node_type == "class_declaration":
            name_node = actual_node.child_by_field_name("name")
            name = name_node.text.decode("utf-8", errors="replace") if name_node else "anonymous"
            target = node if is_exported else actual_node
            start_line = target.start_point[0] + 1
            end_line = target.end_point[0] + 1
            text = content_bytes[target.start_byte:target.end_byte].decode("utf-8", errors="replace")

            chunks.append(CodeChunk(
                text=text,
                ast_type="class",
                function_name=name,
                language=language,
                start_line=start_line,
                end_line=end_line,
                content_hash=compute_sha256(text),
            ))

            body = actual_node.child_by_field_name("body")
            if body:
                for child in body.children:
                    traverse(child, in_class=True)
            return

        # 3. Interface declaration (TypeScript)
        if node_type == "interface_declaration":
            name_node = actual_node.child_by_field_name("name")
            name = name_node.text.decode("utf-8", errors="replace") if name_node else "anonymous"
            target = node if is_exported else actual_node
            start_line = target.start_point[0] + 1
            end_line = target.end_point[0] + 1
            text = content_bytes[target.start_byte:target.end_byte].decode("utf-8", errors="replace")

            chunks.append(CodeChunk(
                text=text,
                ast_type="interface",
                function_name=name,
                language=language,
                start_line=start_line,
                end_line=end_line,
                content_hash=compute_sha256(text),
            ))
            return

        # 4. Method definition (inside class)
        if node_type == "method_definition":
            name_node = actual_node.child_by_field_name("name")
            name = name_node.text.decode("utf-8", errors="replace") if name_node else "anonymous"
            start_line = actual_node.start_point[0] + 1
            end_line = actual_node.end_point[0] + 1
            text = content_bytes[actual_node.start_byte:actual_node.end_byte].decode("utf-8", errors="replace")

            chunks.append(CodeChunk(
                text=text,
                ast_type="method",
                function_name=name,
                language=language,
                start_line=start_line,
                end_line=end_line,
                content_hash=compute_sha256(text),
            ))

            body = actual_node.child_by_field_name("body")
            if body:
                for child in body.children:
                    traverse(child, in_class=False)
            return

        # 5. Arrow functions or function expressions assigned to const / let / var
        # E.g.: const handleClick = () => { ... };
        if node_type in ("lexical_declaration", "variable_declaration"):
            target = node if is_exported else actual_node
            for decl in actual_node.children:
                if decl.type == "variable_declarator":
                    val = decl.child_by_field_name("value")
                    if val and val.type in ("arrow_function", "function_expression"):
                        name_node = decl.child_by_field_name("name")
                        name = name_node.text.decode("utf-8", errors="replace") if name_node else "anonymous"
                        start_line = target.start_point[0] + 1
                        end_line = target.end_point[0] + 1
                        text = content_bytes[target.start_byte:target.end_byte].decode("utf-8", errors="replace")

                        chunks.append(CodeChunk(
                            text=text,
                            ast_type="function",
                            function_name=name,
                            language=language,
                            start_line=start_line,
                            end_line=end_line,
                            content_hash=compute_sha256(text),
                        ))

                        # Recurse for nested functions inside arrow function body
                        body = val.child_by_field_name("body")
                        if body:
                            for child in body.children:
                                traverse(child, in_class=False)
                        return

        # For any other node, traverse children
        for child in node.children:
            traverse(child, in_class)

    traverse(root_node, in_class=False)
    return chunks
