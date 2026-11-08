from cron_calc import next_minute_step

def test_cron():
    assert next_minute_step(55, 10) == 5

if __name__ == "__main__":
    test_cron()
