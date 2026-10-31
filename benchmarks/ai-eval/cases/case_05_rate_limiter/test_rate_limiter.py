from rate_limiter import check_rate_limit

def test_rate_limit():
    now = 1000.0
    history = [920.0, 930.0, 950.0]
    # Window 60s -> window_start is 940.0. Only 950.0 is inside window!
    assert check_rate_limit(history, max_runs=2, window_sec=60, now=now) is True
