"""
Generates 10 realistic benchmark bug-fix cases in benchmarks/ai-eval/cases/.
Each case contains:
- case_info.json (metadata: id, title, description, target_file, target_function, query)
- source file containing project code with multiple functions/classes
- test file containing the reproducing test that fails on the bug
"""

import os
import json

CASES_DIR = os.path.dirname(os.path.abspath(__file__))

cases = [
    {
        "id": "case_01_pagination",
        "title": "Off-by-one in pagination offset",
        "description": "calculate_page_offset calculates offset incorrectly when page is 1 by subtracting 0 instead of 1",
        "target_file": "pagination.py",
        "target_function": "calculate_page_offset",
        "query": "fix off by one page offset calculation in pagination",
        "source": '''
def get_total_pages(total_items: int, page_size: int) -> int:
    import math
    if page_size <= 0:
        return 0
    return math.ceil(total_items / page_size)

def calculate_page_offset(page: int, page_size: int) -> int:
    """Calculates zero-based database offset for 1-based page numbers."""
    # BUG: using page instead of (page - 1) causes page 1 to skip first page_size items
    return page * page_size

def paginate_query(items: list, page: int, page_size: int) -> list:
    offset = calculate_page_offset(page, page_size)
    return items[offset:offset + page_size]
''',
        "test": '''
from pagination import calculate_page_offset

def test_page_offset():
    # Page 1 should start at index 0
    assert calculate_page_offset(1, 10) == 0
'''
    },
    {
        "id": "case_02_jwt_auth",
        "title": "Token expiry timestamp verification unit mismatch",
        "description": "verify_token_expiry compares seconds against milliseconds without conversion",
        "target_file": "auth.py",
        "target_function": "verify_token_expiry",
        "query": "fix JWT token expiry verification timestamp milliseconds comparison",
        "source": '''
import time

def decode_header(token: str) -> dict:
    return {"alg": "HS256", "typ": "JWT"}

def verify_token_expiry(payload: dict, current_time_ms: int) -> bool:
    """Validates that JWT exp claim is strictly in the future."""
    exp = payload.get("exp")
    if not exp:
        return False
    # BUG: exp is in seconds from epoch, but current_time_ms is in milliseconds
    return exp > current_time_ms

def extract_subject(payload: dict) -> str:
    return payload.get("sub", "")
''',
        "test": '''
import time
from auth import verify_token_expiry

def test_expiry():
    now_ms = int(time.time() * 1000)
    exp_seconds = int(time.time()) + 3600
    assert verify_token_expiry({"exp": exp_seconds}, now_ms) is True
'''
    },
    {
        "id": "case_03_tax_calc",
        "title": "Tax rounding truncation error",
        "description": "compute_sales_tax truncates decimals instead of standard half-up rounding",
        "target_file": "tax.py",
        "target_function": "compute_sales_tax",
        "query": "fix sales tax calculation cents rounding truncation",
        "source": '''
def get_tax_rate(state_code: str) -> float:
    rates = {"NY": 0.08875, "CA": 0.0725, "TX": 0.0625}
    return rates.get(state_code.upper(), 0.05)

def compute_sales_tax(subtotal: float, state_code: str) -> float:
    """Computes rounded tax in cents."""
    rate = get_tax_rate(state_code)
    raw_tax = subtotal * rate
    # BUG: int truncation loses fractional cents instead of round half-up
    return int(raw_tax * 100) / 100.0

def generate_invoice_total(subtotal: float, state_code: str) -> float:
    tax = compute_sales_tax(subtotal, state_code)
    return round(subtotal + tax, 2)
''',
        "test": '''
from tax import compute_sales_tax

def test_sales_tax():
    # 10.99 * 0.08875 = 0.9753625 -> should round to 0.98
    assert compute_sales_tax(10.99, "NY") == 0.98
'''
    },
    {
        "id": "case_04_cache_ttl",
        "title": "Cache key invalidation missing namespace",
        "description": "invalidate_cache_key deletes raw key without applying environment namespace prefix",
        "target_file": "cache.py",
        "target_function": "invalidate_cache_key",
        "query": "fix cache key invalidation missing prefix namespace",
        "source": '''
class CacheManager:
    def __init__(self, prefix: str = "app:v1"):
        self.prefix = prefix
        self.store = {}

    def format_key(self, raw_key: str) -> str:
        return f"{self.prefix}:{raw_key}"

    def set(self, key: str, value: str):
        self.store[self.format_key(key)] = value

    def invalidate_cache_key(self, raw_key: str):
        """Removes a key from cache."""
        # BUG: deleting raw_key directly instead of format_key(raw_key)
        self.store.pop(raw_key, None)
''',
        "test": '''
from cache import CacheManager

def test_invalidation():
    cm = CacheManager("test")
    cm.set("user:10", "alice")
    cm.invalidate_cache_key("user:10")
    assert "test:user:10" not in cm.store
'''
    },
    {
        "id": "case_05_rate_limiter",
        "title": "Rate limiter window expiry cleanup bug",
        "description": "check_rate_limit filters out timestamps after current time instead of before window start",
        "target_file": "rate_limiter.py",
        "target_function": "check_rate_limit",
        "query": "fix rate limiter sliding window timestamp expiry calculation",
        "source": '''
import time

def parse_window_spec(spec: str) -> int:
    return 60 if spec == "1m" else 3600

def check_rate_limit(timestamps: list, max_runs: int, window_sec: int, now: float) -> bool:
    """Returns True if within rate limit, False if rate limited."""
    window_start = now - window_sec
    # BUG: condition > now instead of < window_start
    valid = [ts for ts in timestamps if ts > now]
    return len(valid) < max_runs

def log_rate_limit_violation(user_id: str, limit: int):
    pass
''',
        "test": '''
from rate_limiter import check_rate_limit

def test_rate_limit():
    now = 1000.0
    history = [920.0, 930.0, 950.0]
    # Window 60s -> window_start is 940.0. Only 950.0 is inside window!
    assert check_rate_limit(history, max_runs=2, window_sec=60, now=now) is True
'''
    },
    {
        "id": "case_06_markdown_parser",
        "title": "Unclosed fenced code block parser",
        "description": "parse_fenced_code_blocks drops text when closing backticks are omitted at EOF",
        "target_file": "markdown.ts",
        "target_function": "parseFencedCodeBlocks",
        "query": "fix markdown fenced code block parser handling unclosed backticks",
        "source": '''
export interface CodeBlock {
    lang: string;
    code: string;
}

export function extractFrontmatter(source: string): Record<string, string> {
    return {};
}

export function parseFencedCodeBlocks(markdown: string): CodeBlock[] {
    const lines = markdown.split("\\n");
    const blocks: CodeBlock[] = [];
    let inside = false;
    let currentLang = "";
    let buffer: string[] = [];

    for (const line of lines) {
        if (line.startsWith("```")) {
            if (!inside) {
                inside = true;
                currentLang = line.slice(3).trim();
                buffer = [];
            } else {
                inside = false;
                blocks.push({ lang: currentLang, code: buffer.join("\\n") });
            }
        } else if (inside) {
            buffer.push(line);
        }
    }
    // BUG: if inside is still true at EOF, buffer is discarded
    return blocks;
}
''',
        "test": '''
import { parseFencedCodeBlocks } from "./markdown";

const md = "```ts\\nconst x = 1;";
const blocks = parseFencedCodeBlocks(md);
if (blocks.length !== 1) throw new Error("Expected 1 block for unclosed fence");
'''
    },
    {
        "id": "case_07_email_validator",
        "title": "Email validator rejects plus signs",
        "description": "validateEmailAddress regex omits plus characters in local email parts",
        "target_file": "validator.ts",
        "target_function": "validateEmailAddress",
        "query": "fix email validation regex to support plus sign addressing",
        "source": '''
export function sanitizeUsername(name: string): string {
    return name.trim().toLowerCase();
}

export function validateEmailAddress(email: string): boolean {
    // BUG: misses + sign in local-part regex character set [a-zA-Z0-9._-]
    const regex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/;
    return regex.test(email);
}

export function getEmailDomain(email: string): string {
    return email.split("@")[1] || "";
}
''',
        "test": '''
import { validateEmailAddress } from "./validator";

if (!validateEmailAddress("alice+codesync@example.com")) {
    throw new Error("Valid plus-addressed email was rejected!");
}
'''
    },
    {
        "id": "case_08_retry_backoff",
        "title": "Exponential backoff calculation overflow",
        "description": "computeBackoffDelay does not cap exponent result before multiplying by base delay",
        "target_file": "retry.ts",
        "target_function": "computeBackoffDelay",
        "query": "fix exponential retry backoff delay max limit cap overflow",
        "source": '''
export interface BackoffConfig {
    initialDelayMs: number;
    maxDelayMs: number;
    factor: number;
}

export function computeBackoffDelay(attempt: number, config: BackoffConfig): number {
    // BUG: Math.min is not applied to maxDelayMs, causing multi-hour delay on attempt 20
    const delay = config.initialDelayMs * Math.pow(config.factor, attempt);
    return delay;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(res => setTimeout(res, ms));
}
''',
        "test": '''
import { computeBackoffDelay } from "./retry";

const delay = computeBackoffDelay(20, { initialDelayMs: 1000, maxDelayMs: 30000, factor: 2 });
if (delay > 30000) throw new Error("Backoff delay exceeded maxDelayMs");
'''
    },
    {
        "id": "case_09_query_builder",
        "title": "SQL query builder trailing AND bug",
        "description": "buildWhereClause appends AND keyword even when conditions list has only 1 clause",
        "target_file": "query_builder.ts",
        "target_function": "buildWhereClause",
        "query": "fix SQL where clause builder trailing AND clause generation",
        "source": '''
export function sanitizeIdentifier(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, "");
}

export function buildWhereClause(clauses: string[]): string {
    if (!clauses || clauses.length === 0) return "";
    let sql = "WHERE ";
    // BUG: join with AND + trailing AND
    for (const c of clauses) {
        sql += c + " AND ";
    }
    return sql;
}

export function buildSelect(table: string, fields: string[]): string {
    return `SELECT ${fields.join(", ")} FROM ${table}`;
}
''',
        "test": '''
import { buildWhereClause } from "./query_builder";

const sql = buildWhereClause(["status = 'active'"]);
if (sql.endsWith("AND ")) throw new Error("Trailing AND present in query");
'''
    },
    {
        "id": "case_10_queue_stats",
        "title": "Queue throughput division by zero",
        "description": "calculateThroughput divides by zero when elapsed seconds rounds to 0",
        "target_file": "metrics.ts",
        "target_function": "calculateThroughput",
        "query": "fix queue throughput calculation division by zero when elapsed is zero",
        "source": '''
export interface QueueMetrics {
    processedCount: number;
    elapsedSeconds: number;
}

export function calculateThroughput(metrics: QueueMetrics): number {
    // BUG: throws or returns Infinity when elapsedSeconds is 0.0
    return metrics.processedCount / metrics.elapsedSeconds;
}

export function formatThroughput(rate: number): string {
    return `${rate.toFixed(2)} jobs/sec`;
}
''',
        "test": '''
import { calculateThroughput } from "./metrics";

const rate = calculateThroughput({ processedCount: 10, elapsedSeconds: 0 });
if (!Number.isFinite(rate)) throw new Error("Rate should be 0 or finite when elapsed is 0");
'''
    }
]

for c in cases:
    case_path = os.path.join(CASES_DIR, c["id"])
    os.makedirs(case_path, exist_ok=True)

    # 1. case_info.json
    info = {
        "id": c["id"],
        "title": c["title"],
        "description": c["description"],
        "target_file": c["target_file"],
        "target_function": c["target_function"],
        "query": c["query"],
    }
    with open(os.path.join(case_path, "case_info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2)

    # 2. Source file
    with open(os.path.join(case_path, c["target_file"]), "w", encoding="utf-8") as f:
        f.write(c["source"].strip() + "\n")

    # 3. Test file
    test_filename = "test_" + c["target_file"] if c["target_file"].endswith(".py") else c["target_file"].replace(".ts", ".test.ts")
    with open(os.path.join(case_path, test_filename), "w", encoding="utf-8") as f:
        f.write(c["test"].strip() + "\n")

print(f"Successfully generated {len(cases)} benchmark cases in {CASES_DIR}")
