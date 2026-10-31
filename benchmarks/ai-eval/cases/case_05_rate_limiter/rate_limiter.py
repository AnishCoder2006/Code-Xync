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
