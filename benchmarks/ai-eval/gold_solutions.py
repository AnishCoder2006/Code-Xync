"""
Gold solutions for all 25 benchmark cases.
"""

GOLD_SOLUTIONS = {
    "case_01_pagination": '''def get_total_pages(total_items: int, page_size: int) -> int:
    import math
    if page_size <= 0:
        return 0
    return math.ceil(total_items / page_size)

def calculate_page_offset(page: int, page_size: int) -> int:
    """Calculates zero-based database offset for 1-based page numbers."""
    return (page - 1) * page_size

def paginate_query(items: list, page: int, page_size: int) -> list:
    offset = calculate_page_offset(page, page_size)
    return items[offset:offset + page_size]
''',

    "case_02_jwt_auth": '''import time

def decode_header(token: str) -> dict:
    return {"alg": "HS256", "typ": "JWT"}

def verify_token_expiry(payload: dict, current_time_ms: int) -> bool:
    """Validates that JWT exp claim is strictly in the future."""
    exp = payload.get("exp")
    if not exp:
        return False
    return exp * 1000 > current_time_ms

def extract_subject(payload: dict) -> str:
    return payload.get("sub", "")
''',

    "case_03_tax_calc": '''def get_tax_rate(state_code: str) -> float:
    rates = {"NY": 0.08875, "CA": 0.0725, "TX": 0.0625}
    return rates.get(state_code.upper(), 0.05)

def compute_sales_tax(subtotal: float, state_code: str) -> float:
    """Computes rounded tax in cents."""
    rate = get_tax_rate(state_code)
    raw_tax = subtotal * rate
    return round(raw_tax, 2)

def generate_invoice_total(subtotal: float, state_code: str) -> float:
    tax = compute_sales_tax(subtotal, state_code)
    return round(subtotal + tax, 2)
''',

    "case_04_cache_ttl": '''class CacheManager:
    def __init__(self, prefix: str = "app:v1"):
        self.prefix = prefix
        self.store = {}

    def format_key(self, raw_key: str) -> str:
        return f"{self.prefix}:{raw_key}"

    def set(self, key: str, value: str):
        self.store[self.format_key(key)] = value

    def invalidate_cache_key(self, raw_key: str):
        """Removes a key from cache."""
        self.store.pop(self.format_key(raw_key), None)
''',

    "case_05_rate_limiter": '''def parse_window_spec(spec: str) -> int:
    return 60 if spec == "1m" else 3600

def check_rate_limit(timestamps: list, max_runs: int, window_sec: int, now: float) -> bool:
    """Returns True if within rate limit, False if rate limited."""
    window_start = now - window_sec
    valid = [ts for ts in timestamps if ts >= window_start]
    return len(valid) < max_runs

def log_rate_limit_violation(user_id: str, limit: int):
    pass
''',

    "case_06_markdown_parser": '''function extractFrontmatter(source) {
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
    if (inside) {
        blocks.push({ lang: currentLang, code: buffer.join("\\n") });
    }
    return blocks;
}

module.exports = { parseFencedCodeBlocks, extractFrontmatter };
''',

    "case_07_email_validator": '''function sanitizeUsername(name) {
    return name.trim().toLowerCase();
}

function validateEmailAddress(email) {
    const regex = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/;
    return regex.test(email);
}

function getEmailDomain(email) {
    return email.split("@")[1] || "";
}

module.exports = { sanitizeUsername, validateEmailAddress, getEmailDomain };
''',

    "case_08_retry_backoff": '''function computeBackoffDelay(attempt, config) {
    const delay = config.initialDelayMs * Math.pow(config.factor, attempt);
    return Math.min(delay, config.maxDelayMs);
}

function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

module.exports = { computeBackoffDelay, sleep };
''',

    "case_09_query_builder": '''function sanitizeIdentifier(id) {
    return id.replace(/[^a-zA-Z0-9_]/g, "");
}

function buildWhereClause(clauses) {
    if (!clauses || clauses.length === 0) return "";
    return "WHERE " + clauses.join(" AND ");
}

function buildSelect(table, fields) {
    return `SELECT ${fields.join(", ")} FROM ${table}`;
}

module.exports = { sanitizeIdentifier, buildWhereClause, buildSelect };
''',

    "case_10_queue_stats": '''function calculateThroughput(metrics) {
    if (!metrics.elapsedSeconds || metrics.elapsedSeconds <= 0) {
        return 0;
    }
    return metrics.processedCount / metrics.elapsedSeconds;
}

function formatThroughput(rate) {
    return `${rate.toFixed(2)} jobs/sec`;
}

module.exports = { calculateThroughput, formatThroughput };
''',

    "case_11_string_truncate": '''def truncate_text(text: str, max_len: int = 10) -> str:
    """Truncates text and appends ... if longer than max_len."""
    if len(text) <= max_len:
        return text
    return text[:max_len - 3] + "..."

def count_words(text: str) -> int:
    return len(text.split())
''',

    "case_12_url_join": '''def clean_query(query: str) -> str:
    return query.strip("?")

def join_url_path(base: str, path: str) -> str:
    """Joins URL base and path without duplicate slashes."""
    return base.rstrip("/") + "/" + path.lstrip("/")
''',

    "case_13_hex_color": '''def is_valid_hex(hex_str: str) -> bool:
    return hex_str.startswith("#")

def expand_hex_color(hex_str: str) -> str:
    """Expands #fff to #ffffff."""
    hex_str = hex_str.lstrip("#")
    if len(hex_str) == 3:
        return "#" + "".join(c * 2 for c in hex_str)
    return "#" + hex_str
''',

    "case_14_user_age": '''from datetime import date

def calculate_age(birth_date: date, current_date: date) -> int:
    """Calculates age in years."""
    years = current_date.year - birth_date.year
    if (current_date.month, current_date.day) < (birth_date.month, birth_date.day):
        years -= 1
    return years
''',

    "case_15_binary_search": '''def binary_search(arr: list, target: int) -> int:
    """Returns index of target or -1."""
    left = 0
    right = len(arr) - 1
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

    "case_16_clamp_value": '''def clamp_val(val: float, min_val: float, max_val: float) -> float:
    """Clamps val within [min_val, max_val]."""
    if val < min_val:
        return min_val
    if val > max_val:
        return max_val
    return val
''',

    "case_17_levenshtein": '''def levenshtein_distance(s1: str, s2: str) -> int:
    m, n = len(s1), len(s2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    return dp[m][n]
''',

    "case_18_cookie_parser": '''def parse_cookie_header(header: str) -> dict:
    cookies = {}
    if not header:
        return cookies
    for part in header.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies
''',

    "case_19_slugify": '''import re

def slugify_string(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")
''',

    "case_20_median": '''def calculate_median(numbers: list) -> float:
    if not numbers:
        return 0.0
    s = sorted(numbers)
    n = len(s)
    mid = n // 2
    if n % 2 == 1:
        return float(s[mid])
    return (s[mid - 1] + s[mid]) / 2.0
''',

    "case_21_deep_clone": '''def deep_merge(dict_a: dict, dict_b: dict) -> dict:
    result = dict(dict_a)
    for k, v in dict_b.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = deep_merge(result[k], v)
        else:
            result[k] = v
    return result
''',

    "case_22_ip_filter": '''import ipaddress

def is_private_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
        return ip.is_private
    except ValueError:
        return False
''',

    "case_23_cron_interval": '''def next_minute_step(current_min: int, step: int) -> int:
    """Calculates next minute in an hourly cron interval."""
    return (current_min + step) % 60
''',

    "case_24_fizzbuzz_ext": '''def custom_fizzbuzz(n: int) -> str:
    if n % 15 == 0:
        return "FizzBuzz"
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    return str(n)
''',

    "case_25_semantic_version": '''def compare_semver(v1: str, v2: str) -> int:
    t1 = tuple(map(int, v1.split(".")))
    t2 = tuple(map(int, v2.split(".")))
    if t1 < t2:
        return -1
    elif t1 > t2:
        return 1
    return 0
'''
}

