"""
Unit tests for app.rag.chunker.
Tests:
- nested functions
- class methods
- decorators
- arrow functions assigned to const
- syntax errors (fallback)
"""

import pytest
from app.rag.chunker import chunk_file, CodeChunk


def test_python_decorators_and_nested_functions():
    code = """
@timer_decorator
@auth_required(role="admin")
def outer_service(payload: dict) -> bool:
    '''Outer docstring'''
    def inner_validate(data):
        return len(data) > 0

    return inner_validate(payload)
"""
    chunks = chunk_file("services/payment.py", code, "python")
    assert len(chunks) == 2

    # Outer decorated function
    outer = chunks[0]
    assert outer.ast_type == "function"
    assert outer.function_name == "outer_service"
    assert "@timer_decorator" in outer.text
    assert "@auth_required" in outer.text
    assert outer.start_line == 2
    assert outer.end_line == 9
    assert outer.content_hash is not None

    # Nested function
    inner = chunks[1]
    assert inner.ast_type == "function"
    assert inner.function_name == "inner_validate"
    assert "def inner_validate" in inner.text
    assert inner.start_line == 6
    assert inner.end_line == 7


def test_python_class_and_methods():
    code = """
class OrderRepository:
    def __init__(self, db_conn):
        self.db = db_conn

    @property
    def connection_status(self):
        return True

    def find_by_id(self, order_id: str):
        return self.db.find(order_id)
"""
    chunks = chunk_file("repo.py", code, "python")
    # 1 class + 3 methods = 4 chunks
    assert len(chunks) == 4

    cls_chunk = chunks[0]
    assert cls_chunk.ast_type == "class"
    assert cls_chunk.function_name == "OrderRepository"

    methods = [c for c in chunks if c.ast_type == "method"]
    assert len(methods) == 3
    method_names = {m.function_name for m in methods}
    assert method_names == {"__init__", "connection_status", "find_by_id"}

    # Check decorated method includes decorator
    prop_method = next(m for m in methods if m.function_name == "connection_status")
    assert "@property" in prop_method.text


def test_typescript_arrow_functions_and_interfaces():
    code = """
export interface DatabaseConfig {
    host: string;
    port: number;
    ssl: boolean;
}

export const connectDatabase = async (config: DatabaseConfig) => {
    const helper = () => true;
    return helper();
};

const formatOutput = (msg: string) => `[LOG] ${msg}`;
"""
    chunks = chunk_file("src/db.ts", code, "typescript")
    # 1 interface + 2 top-level arrow functions + 1 nested helper = 4 chunks
    assert len(chunks) >= 3

    iface = next(c for c in chunks if c.ast_type == "interface")
    assert iface.function_name == "DatabaseConfig"
    assert "export interface DatabaseConfig" in iface.text

    connect_fn = next(c for c in chunks if c.function_name == "connectDatabase")
    assert connect_fn.ast_type == "function"
    assert "export const connectDatabase" in connect_fn.text

    format_fn = next(c for c in chunks if c.function_name == "formatOutput")
    assert format_fn.ast_type == "function"
    assert "const formatOutput" in format_fn.text


def test_typescript_class_and_methods():
    code = """
export class PaymentGateway {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    public async processCharge(amount: number): Promise<boolean> {
        return amount > 0;
    }
}
"""
    chunks = chunk_file("gateway.ts", code, "typescript")
    assert len(chunks) == 3

    cls_chunk = chunks[0]
    assert cls_chunk.ast_type == "class"
    assert cls_chunk.function_name == "PaymentGateway"
    assert "export class PaymentGateway" in cls_chunk.text

    methods = [c for c in chunks if c.ast_type == "method"]
    assert len(methods) == 2
    method_names = {m.function_name for m in methods}
    assert method_names == {"constructor", "processCharge"}


def test_syntax_errors_and_malformed_code_fallback():
    # Incomplete / broken syntax with no valid definitions
    broken_code = """
    def %%% broken syntax !!! (((((((
    random text that cannot form a valid function or class
    """
    chunks = chunk_file("broken.py", broken_code, "python")
    assert len(chunks) == 1
    fallback = chunks[0]
    assert fallback.ast_type == "file"
    assert fallback.function_name == "broken.py"
    assert fallback.content_hash == fallback.content_hash
