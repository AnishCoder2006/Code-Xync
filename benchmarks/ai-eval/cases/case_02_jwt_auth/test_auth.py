import time
from auth import verify_token_expiry

def test_expiry():
    now_ms = int(time.time() * 1000)
    exp_seconds = int(time.time()) + 3600
    assert verify_token_expiry({"exp": exp_seconds}, now_ms) is True
