from rate_limiter import check_rate_limit

def test_rate_limit():
    now = 1000.0
    history = [990.0, 995.0, 999.0]
    # 3 requests in the 60s window exceeding limit of 2 must return False
    assert check_rate_limit(history, max_runs=2, window_sec=60, now=now) is False

if __name__ == "__main__":
    test_rate_limit()
