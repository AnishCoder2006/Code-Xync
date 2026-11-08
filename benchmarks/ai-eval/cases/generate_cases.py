"""
Updates all 25 benchmark cases with:
1. Genuine bugs in original source code.
2. Executable test files (calling the test function at the bottom for Python, using plain Node.js CommonJS for JS).
3. Plain JS for cases 06-10 (removing .ts dependencies).
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
        "source": '''def get_total_pages(total_items: int, page_size: int) -> int:
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
        "test_file": "test_pagination.py",
        "test": '''from pagination import calculate_page_offset

def test_page_offset():
    assert calculate_page_offset(1, 10) == 0

if __name__ == "__main__":
    test_page_offset()
'''
    },
    {
        "id": "case_02_jwt_auth",
        "title": "Token expiry timestamp verification unit mismatch",
        "description": "verify_token_expiry compares seconds against milliseconds without conversion",
        "target_file": "auth.py",
        "target_function": "verify_token_expiry",
        "query": "fix JWT token expiry verification timestamp milliseconds comparison",
        "source": '''import time

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
        "test_file": "test_auth.py",
        "test": '''import time
from auth import verify_token_expiry

def test_expiry():
    now_ms = int(time.time() * 1000)
    exp_seconds = int(time.time()) + 3600
    assert verify_token_expiry({"exp": exp_seconds}, now_ms) is True

if __name__ == "__main__":
    test_expiry()
'''
    },
    {
        "id": "case_03_tax_calc",
        "title": "Tax rounding truncation error",
        "description": "compute_sales_tax truncates decimals instead of standard half-up rounding",
        "target_file": "tax.py",
        "target_function": "compute_sales_tax",
        "query": "fix sales tax calculation cents rounding truncation",
        "source": '''def get_tax_rate(state_code: str) -> float:
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
        "test_file": "test_tax.py",
        "test": '''from tax import compute_sales_tax

def test_sales_tax():
    assert compute_sales_tax(10.99, "NY") == 0.98

if __name__ == "__main__":
    test_sales_tax()
'''
    },
    {
        "id": "case_04_cache_ttl",
        "title": "Cache key invalidation missing namespace",
        "description": "invalidate_cache_key deletes raw key without applying environment namespace prefix",
        "target_file": "cache.py",
        "target_function": "invalidate_cache_key",
        "query": "fix cache key invalidation missing prefix namespace",
        "source": '''class CacheManager:
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
        "test_file": "test_cache.py",
        "test": '''from cache import CacheManager

def test_invalidation():
    cm = CacheManager("test")
    cm.set("user:10", "alice")
    cm.invalidate_cache_key("user:10")
    assert "test:user:10" not in cm.store

if __name__ == "__main__":
    test_invalidation()
'''
    },
    {
        "id": "case_05_rate_limiter",
        "title": "Rate limiter window expiry cleanup bug",
        "description": "check_rate_limit filters out timestamps after current time instead of before window start",
        "target_file": "rate_limiter.py",
        "target_function": "check_rate_limit",
        "query": "fix rate limiter sliding window timestamp expiry calculation",
        "source": '''def parse_window_spec(spec: str) -> int:
    return 60 if spec == "1m" else 3600

def check_rate_limit(timestamps: list, max_runs: int, window_sec: int, now: float) -> bool:
    """Returns True if within rate limit, False if rate limited."""
    window_start = now - window_sec
    # BUG: condition > now instead of >= window_start
    valid = [ts for ts in timestamps if ts > now]
    return len(valid) < max_runs

def log_rate_limit_violation(user_id: str, limit: int):
    pass
''',
        "test_file": "test_rate_limiter.py",
        "test": '''from rate_limiter import check_rate_limit

def test_rate_limit():
    now = 1000.0
    history = [990.0, 995.0, 999.0]
    # 3 requests in the 60s window exceeding limit of 2 must return False
    assert check_rate_limit(history, max_runs=2, window_sec=60, now=now) is False

if __name__ == "__main__":
    test_rate_limit()
'''
    },
    {
        "id": "case_06_markdown_parser",
        "title": "Unclosed fenced code block parser",
        "description": "parse_fenced_code_blocks drops text when closing backticks are omitted at EOF",
        "target_file": "markdown.js",
        "target_function": "parseFencedCodeBlocks",
        "query": "fix markdown fenced code block parser handling unclosed backticks",
        "source": '''function extractFrontmatter(source) {
    return {};
}

function parseFencedCodeBlocks(markdown) {
    const lines = markdown.split("\\n");
    const blocks = [];
    let inside = false;
    let currentLang = "";
    let buffer = [];

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

module.exports = { parseFencedCodeBlocks, extractFrontmatter };
''',
        "test_file": "markdown.test.js",
        "test": '''const { parseFencedCodeBlocks } = require("./markdown");

const md = "```ts\\nconst x = 1;";
const blocks = parseFencedCodeBlocks(md);
if (blocks.length !== 1) {
    throw new Error("Expected 1 block for unclosed fence");
}
console.log("All tests passed.");
'''
    },
    {
        "id": "case_07_email_validator",
        "title": "Email validator rejects plus signs",
        "description": "validateEmailAddress regex omits plus characters in local email parts",
        "target_file": "validator.js",
        "target_function": "validateEmailAddress",
        "query": "fix email validation regex to support plus sign addressing",
        "source": '''function sanitizeUsername(name) {
    return name.trim().toLowerCase();
}

function validateEmailAddress(email) {
    // BUG: misses + sign in local-part regex character set [a-zA-Z0-9._-]
    const regex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/;
    return regex.test(email);
}

function getEmailDomain(email) {
    return email.split("@")[1] || "";
}

module.exports = { sanitizeUsername, validateEmailAddress, getEmailDomain };
''',
        "test_file": "validator.test.js",
        "test": '''const { validateEmailAddress } = require("./validator");

if (!validateEmailAddress("alice+codesync@example.com")) {
    throw new Error("Valid plus-addressed email was rejected!");
}
console.log("All tests passed.");
'''
    },
    {
        "id": "case_08_retry_backoff",
        "title": "Exponential backoff calculation overflow",
        "description": "computeBackoffDelay does not cap exponent result before multiplying by base delay",
        "target_file": "retry.js",
        "target_function": "computeBackoffDelay",
        "query": "fix exponential retry backoff delay max limit cap overflow",
        "source": '''function computeBackoffDelay(attempt, config) {
    // BUG: Math.min is not applied to maxDelayMs, causing unbounded delay
    const delay = config.initialDelayMs * Math.pow(config.factor, attempt);
    return delay;
}

function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

module.exports = { computeBackoffDelay, sleep };
''',
        "test_file": "retry.test.js",
        "test": '''const { computeBackoffDelay } = require("./retry");

const delay = computeBackoffDelay(20, { initialDelayMs: 1000, maxDelayMs: 30000, factor: 2 });
if (delay > 30000) {
    throw new Error("Backoff delay exceeded maxDelayMs");
}
console.log("All tests passed.");
'''
    },
    {
        "id": "case_09_query_builder",
        "title": "SQL query builder trailing AND bug",
        "description": "buildWhereClause appends AND keyword even when conditions list has only 1 clause",
        "target_file": "query_builder.js",
        "target_function": "buildWhereClause",
        "query": "fix SQL where clause builder trailing AND clause generation",
        "source": '''function sanitizeIdentifier(id) {
    return id.replace(/[^a-zA-Z0-9_]/g, "");
}

function buildWhereClause(clauses) {
    if (!clauses || clauses.length === 0) return "";
    let sql = "WHERE ";
    // BUG: join with AND leaves trailing AND
    for (const c of clauses) {
        sql += c + " AND ";
    }
    return sql;
}

function buildSelect(table, fields) {
    return `SELECT ${fields.join(", ")} FROM ${table}`;
}

module.exports = { sanitizeIdentifier, buildWhereClause, buildSelect };
''',
        "test_file": "query_builder.test.js",
        "test": '''const { buildWhereClause } = require("./query_builder");

const sql = buildWhereClause(["status = 'active'"]);
if (sql.endsWith("AND ")) {
    throw new Error("Trailing AND present in query");
}
console.log("All tests passed.");
'''
    },
    {
        "id": "case_10_queue_stats",
        "title": "Queue throughput division by zero",
        "description": "calculateThroughput divides by zero when elapsed seconds rounds to 0",
        "target_file": "metrics.js",
        "target_function": "calculateThroughput",
        "query": "fix queue throughput calculation division by zero when elapsed is zero",
        "source": '''function calculateThroughput(metrics) {
    // BUG: throws or returns Infinity when elapsedSeconds is 0.0
    return metrics.processedCount / metrics.elapsedSeconds;
}

function formatThroughput(rate) {
    return `${rate.toFixed(2)} jobs/sec`;
}

module.exports = { calculateThroughput, formatThroughput };
''',
        "test_file": "metrics.test.js",
        "test": '''const { calculateThroughput } = require("./metrics");

const rate = calculateThroughput({ processedCount: 10, elapsedSeconds: 0 });
if (!Number.isFinite(rate)) {
    throw new Error("Rate should be 0 or finite when elapsed is 0");
}
console.log("All tests passed.");
'''
    },
    {
        "id": "case_11_string_truncate",
        "title": "String truncation off-by-one length",
        "description": "truncate_text exceeds max_len when appending ellipsis",
        "target_file": "text_utils.py",
        "target_function": "truncate_text",
        "query": "fix string truncate length limit with ellipsis",
        "source": '''def truncate_text(text: str, max_len: int = 10) -> str:
    """Truncates text and appends ... if longer than max_len."""
    if len(text) <= max_len:
        return text
    # BUG: text[:max_len] + "..." has total length max_len + 3
    return text[:max_len] + "..."

def count_words(text: str) -> int:
    return len(text.split())
''',
        "test_file": "test_text_utils.py",
        "test": '''from text_utils import truncate_text

def test_truncate():
    res = truncate_text("hello world long text", max_len=8)
    assert len(res) <= 8

if __name__ == "__main__":
    test_truncate()
'''
    },
    {
        "id": "case_12_url_join",
        "title": "URL join double slash bug",
        "description": "join_url_path creates double slashes when joining base and subpath",
        "target_file": "url_utils.py",
        "target_function": "join_url_path",
        "query": "fix url join path duplicate slash bug",
        "source": '''def clean_query(query: str) -> str:
    return query.strip("?")

def join_url_path(base: str, path: str) -> str:
    """Joins URL base and path without duplicate slashes."""
    # BUG: simple concatenation produces double slash
    return base + "/" + path
''',
        "test_file": "test_url_utils.py",
        "test": '''from url_utils import join_url_path

def test_url_join():
    assert join_url_path("https://api.com/", "/v1/users") == "https://api.com/v1/users"

if __name__ == "__main__":
    test_url_join()
'''
    },
    {
        "id": "case_13_hex_color",
        "title": "Hex color short notation expansion",
        "description": "expand_hex_color fails on 3-char hex strings",
        "target_file": "color.py",
        "target_function": "expand_hex_color",
        "query": "fix 3 digit short hex color code expansion",
        "source": '''def is_valid_hex(hex_str: str) -> bool:
    return hex_str.startswith("#")

def expand_hex_color(hex_str: str) -> str:
    """Expands #fff to #ffffff."""
    hex_str = hex_str.lstrip("#")
    if len(hex_str) == 3:
        # BUG: returns 3-char hex with single characters instead of duplicating
        return "#" + hex_str
    return "#" + hex_str
''',
        "test_file": "test_color.py",
        "test": '''from color import expand_hex_color

def test_expand():
    assert expand_hex_color("#abc") == "#aabbcc"

if __name__ == "__main__":
    test_expand()
'''
    },
    {
        "id": "case_14_user_age",
        "title": "Calculate age birthday check",
        "description": "calculate_age does not account for whether birthday has occurred this year",
        "target_file": "age.py",
        "target_function": "calculate_age",
        "query": "fix user age calculation birthday occurrence check",
        "source": '''from datetime import date

def calculate_age(birth_date: date, current_date: date) -> int:
    """Calculates age in years."""
    # BUG: simply subtracting years without checking month/day
    return current_date.year - birth_date.year
''',
        "test_file": "test_age.py",
        "test": '''from datetime import date
from age import calculate_age

def test_age():
    b = date(2000, 10, 15)
    c = date(2020, 5, 1)
    assert calculate_age(b, c) == 19

if __name__ == "__main__":
    test_age()
'''
    },
    {
        "id": "case_15_binary_search",
        "title": "Binary search off by one",
        "description": "binary_search right pointer boundary off by one",
        "target_file": "search_algo.py",
        "target_function": "binary_search",
        "query": "fix binary search index lookup boundary",
        "source": '''def binary_search(arr: list, target: int) -> int:
    """Returns index of target or -1."""
    left = 0
    # BUG: right boundary off-by-one skips last element
    right = len(arr) - 2
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1
''',
        "test_file": "test_search_algo.py",
        "test": '''from search_algo import binary_search

def test_search():
    assert binary_search([1, 3, 5, 7, 9], 9) == 4

if __name__ == "__main__":
    test_search()
'''
    },
    {
        "id": "case_16_clamp_value",
        "title": "Clamp value min max bounds",
        "description": "clamp_val inverts min and max boundary checks",
        "target_file": "math_utils.py",
        "target_function": "clamp_val",
        "query": "fix clamp value minimum and maximum boundary bounds",
        "source": '''def clamp_val(val: float, min_val: float, max_val: float) -> float:
    """Clamps val within [min_val, max_val]."""
    # BUG: inverts min and max boundary checks
    if val < min_val:
        return max_val
    if val > max_val:
        return min_val
    return val
''',
        "test_file": "test_math_utils.py",
        "test": '''from math_utils import clamp_val

def test_clamp():
    assert clamp_val(15, 0, 10) == 10
    assert clamp_val(-5, 0, 10) == 0

if __name__ == "__main__":
    test_clamp()
'''
    },
    {
        "id": "case_17_levenshtein",
        "title": "Levenshtein distance base cases",
        "description": "levenshtein_distance matrix dimension off-by-one",
        "target_file": "distance.py",
        "target_function": "levenshtein_distance",
        "query": "fix levenshtein distance string difference calculation",
        "source": '''def levenshtein_distance(s1: str, s2: str) -> int:
    # BUG: returns length difference only instead of edit distance
    return abs(len(s1) - len(s2))
''',
        "test_file": "test_distance.py",
        "test": '''from distance import levenshtein_distance

def test_dist():
    assert levenshtein_distance("kitten", "sitting") == 3

if __name__ == "__main__":
    test_dist()
'''
    },
    {
        "id": "case_18_cookie_parser",
        "title": "Cookie parser trimming whitespace",
        "description": "parse_cookie_header leaves trailing spaces in cookie values",
        "target_file": "cookie.py",
        "target_function": "parse_cookie_header",
        "query": "fix cookie header string parsing whitespace trim",
        "source": '''def parse_cookie_header(header: str) -> dict:
    cookies = {}
    if not header:
        return cookies
    for part in header.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            # BUG: misses trimming leading/trailing whitespace
            cookies[k] = v
    return cookies
''',
        "test_file": "test_cookie.py",
        "test": '''from cookie import parse_cookie_header

def test_cookie():
    res = parse_cookie_header("session=abc; user=alice ; role=admin")
    assert "user" in res
    assert res["user"] == "alice"

if __name__ == "__main__":
    test_cookie()
'''
    },
    {
        "id": "case_19_slugify",
        "title": "URL slug generator trailing hyphen",
        "description": "slugify_string leaves duplicate or trailing hyphens",
        "target_file": "slug.py",
        "target_function": "slugify_string",
        "query": "fix url slug generation remove trailing hyphens and duplicate separators",
        "source": '''import re

def slugify_string(text: str) -> str:
    # BUG: forgets to strip leading/trailing hyphens and lowercase
    return re.sub(r"[^a-zA-Z0-9]+", "-", text)
''',
        "test_file": "test_slug.py",
        "test": '''from slug import slugify_string

def test_slug():
    assert slugify_string("Hello, World! -- 2026") == "hello-world-2026"

if __name__ == "__main__":
    test_slug()
'''
    },
    {
        "id": "case_20_median",
        "title": "Median calculation for even list length",
        "description": "calculate_median integer division on even lengths",
        "target_file": "stats.py",
        "target_function": "calculate_median",
        "query": "fix calculate median average of two middle elements for even length",
        "source": '''def calculate_median(numbers: list) -> float:
    if not numbers:
        return 0.0
    s = sorted(numbers)
    n = len(s)
    # BUG: picks mid element directly on even length instead of average of two middle elements
    return float(s[n // 2])
''',
        "test_file": "test_stats.py",
        "test": '''from stats import calculate_median

def test_median():
    assert calculate_median([1, 2, 3, 4]) == 2.5

if __name__ == "__main__":
    test_median()
'''
    },
    {
        "id": "case_21_deep_clone",
        "title": "Dictionary merge deep clone override",
        "description": "deep_merge overwrites nested dicts instead of recursing",
        "target_file": "dict_utils.py",
        "target_function": "deep_merge",
        "query": "fix recursive dictionary deep merge nested keys",
        "source": '''def deep_merge(dict_a: dict, dict_b: dict) -> dict:
    # BUG: shallow merge overwrites nested dicts instead of recursing
    result = dict(dict_a)
    result.update(dict_b)
    return result
''',
        "test_file": "test_dict_utils.py",
        "test": '''from dict_utils import deep_merge

def test_merge():
    a = {"config": {"theme": "dark", "port": 80}}
    b = {"config": {"port": 8080}}
    res = deep_merge(a, b)
    assert "theme" in res["config"]
    assert res["config"]["theme"] == "dark"
    assert res["config"]["port"] == 8080

if __name__ == "__main__":
    test_merge()
'''
    },
    {
        "id": "case_22_ip_filter",
        "title": "Private IPv4 subnet classification",
        "description": "is_private_ip classifies 10.x.x.x addresses",
        "target_file": "net.py",
        "target_function": "is_private_ip",
        "query": "fix private IP address range subnet validation",
        "source": '''def is_private_ip(ip_str: str) -> bool:
    # BUG: checks only 10.x.x.x, misses 192.168.x.x and 172.16.x.x
    return ip_str.startswith("10.")
''',
        "test_file": "test_net.py",
        "test": '''from net import is_private_ip

def test_ip():
    assert is_private_ip("192.168.1.1") is True
    assert is_private_ip("8.8.8.8") is False

if __name__ == "__main__":
    test_ip()
'''
    },
    {
        "id": "case_23_cron_interval",
        "title": "Cron interval minute step overflow",
        "description": "next_minute_step handles 60-minute overflow modulo",
        "target_file": "cron_calc.py",
        "target_function": "next_minute_step",
        "query": "fix cron interval minute step overflow modulo",
        "source": '''def next_minute_step(current_min: int, step: int) -> int:
    """Calculates next minute in an hourly cron interval."""
    # BUG: fails to wrap around 60 minutes
    return current_min + step
''',
        "test_file": "test_cron_calc.py",
        "test": '''from cron_calc import next_minute_step

def test_cron():
    assert next_minute_step(55, 10) == 5

if __name__ == "__main__":
    test_cron()
'''
    },
    {
        "id": "case_24_fizzbuzz_ext",
        "title": "Custom FizzBuzz divisible by both 3 and 5",
        "description": "custom_fizzbuzz checks both condition first",
        "target_file": "fizzbuzz.py",
        "target_function": "custom_fizzbuzz",
        "query": "fix custom fizzbuzz both divisible condition order",
        "source": '''def custom_fizzbuzz(n: int) -> str:
    # BUG: checks 3 before 15, returning Fizz instead of FizzBuzz
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    if n % 15 == 0:
        return "FizzBuzz"
    return str(n)
''',
        "test_file": "test_fizzbuzz.py",
        "test": '''from fizzbuzz import custom_fizzbuzz

def test_fb():
    assert custom_fizzbuzz(15) == "FizzBuzz"
    assert custom_fizzbuzz(9) == "Fizz"

if __name__ == "__main__":
    test_fb()
'''
    },
    {
        "id": "case_25_semantic_version",
        "title": "Semantic version string comparison",
        "description": "compare_semver splits version strings into integer tuples",
        "target_file": "semver.py",
        "target_function": "compare_semver",
        "query": "fix semver version number tuple comparison",
        "source": '''def compare_semver(v1: str, v2: str) -> int:
    # BUG: compares version components as strings lexicographically ("2" > "10")
    t1 = tuple(v1.split("."))
    t2 = tuple(v2.split("."))
    if t1 < t2:
        return -1
    elif t1 > t2:
        return 1
    return 0
''',
        "test_file": "test_semver.py",
        "test": '''from semver import compare_semver

def test_semver():
    # "1.10.0" is newer than "1.2.0", so compare_semver("1.2.0", "1.10.0") should be -1
    assert compare_semver("1.2.0", "1.10.0") == -1

if __name__ == "__main__":
    test_semver()
'''
    }
]

for c in cases:
    case_path = os.path.join(CASES_DIR, c["id"])
    os.makedirs(case_path, exist_ok=True)

    # Clean out any old .ts files if this is cases 06-10
    for old_file in os.listdir(case_path):
        if old_file.endswith(".ts"):
            os.remove(os.path.join(case_path, old_file))

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
    with open(os.path.join(case_path, c["test_file"]), "w", encoding="utf-8") as f:
        f.write(c["test"].strip() + "\n")

print(f"Successfully generated {len(cases)} benchmark cases with verified bugs.")
