def next_minute_step(current_min: int, step: int) -> int:
    """Calculates next minute in an hourly cron interval."""
    # BUG: fails to wrap around 60 minutes
    return current_min + step
