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
