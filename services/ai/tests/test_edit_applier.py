"""
Unit tests for the Edit Applier (Task 7 requirement):
1. Nested functions: replaces nested function without touching outer function, or vice versa.
2. Decorators: replaces decorated function including/preserving decorators.
3. Syntax errors: file with broken syntax before or after target function is still edited cleanly.
"""

import pytest
from app.agent.edit_applier import apply_function_edit, find_function_range


def test_replace_simple_function():
    code = """
def greet(name: str):
    return "Hello " + name

def farewell(name: str):
    return "Goodbye " + name
"""
    new_func = """def greet(name: str):\n    return f"Welcome, {name}!\""""
    res = apply_function_edit(code, "greet", new_func, "app.py", "python")

    assert "Welcome, {name}!" in res.patched_content
    assert "farewell" in res.patched_content
    assert "Goodbye" in res.patched_content
    assert "-    return \"Hello \" + name" in res.diff_patch
    assert "+    return f\"Welcome, {name}!\"" in res.diff_patch


def test_replace_decorated_function():
    code = """
from functools import lru_cache

@lru_cache(maxsize=128)
def fibonacci(n: int) -> int:
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

def helper():
    return True
"""
    new_func = """@lru_cache(maxsize=256)
def fibonacci(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a"""

    res = apply_function_edit(code, "fibonacci", new_func, "fib.py", "python")
    assert "maxsize=256" in res.patched_content
    assert "for _ in range(n):" in res.patched_content
    assert "def helper():" in res.patched_content
    assert "+    for _ in range(n):" in res.diff_patch


def test_replace_nested_functions():
    code = """
def outer_calculator(x: int):
    factor = 10

    def inner_step(val: int):
        # Nested helper
        return val * factor

    return inner_step(x) + 5

def another_func():
    return 42
"""
    # Replace ONLY the inner nested function
    new_inner = """    def inner_step(val: int):
        # Optimized nested helper
        return val * factor * 2"""

    res = apply_function_edit(code, "inner_step", new_inner, "nested.py", "python")
    assert "Optimized nested helper" in res.patched_content
    assert "outer_calculator" in res.patched_content
    assert "another_func" in res.patched_content
    assert "return 42" in res.patched_content

    # Now replace the outer function
    new_outer = """def outer_calculator(x: int):
    return x * 20 + 5"""
    res_outer = apply_function_edit(code, "outer_calculator", new_outer, "nested.py", "python")
    assert "x * 20 + 5" in res_outer.patched_content
    assert "another_func" in res_outer.patched_content


def test_replace_with_syntax_errors_in_file():
    # Syntax error in another function (unclosed parenthesis and broken syntax)
    code = """
def broken_syntax_function(:
    this is completely broken syntax !!!
    (((( unclosed

def target_healthy_function(a: int, b: int) -> int:
    return a - b

def yet_another_broken()
    missing colon
"""
    new_code = """def target_healthy_function(a: int, b: int) -> int:
    return a + b"""

    res = apply_function_edit(code, "target_healthy_function", new_code, "mixed.py", "python")
    assert "return a + b" in res.patched_content
    assert "broken_syntax_function" in res.patched_content
    assert "yet_another_broken" in res.patched_content
    assert "+    return a + b" in res.diff_patch
    assert "-    return a - b" in res.diff_patch


def test_replace_typescript_function():
    code = """
interface User { id: string; }

export function getUserDisplayName(user: User): string {
  return "User " + user.id;
}

export function formatGreeting(): string {
  return "Hello";
}
"""
    new_ts = """export function getUserDisplayName(user: User): string {
  return `User ID: ${user.id}`;
}"""
    res = apply_function_edit(code, "getUserDisplayName", new_ts, "user.ts", "typescript")
    assert "User ID: ${user.id}" in res.patched_content
    assert "formatGreeting" in res.patched_content
    assert "interface User" in res.patched_content
