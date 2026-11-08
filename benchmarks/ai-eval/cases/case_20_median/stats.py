def calculate_median(numbers: list) -> float:
    if not numbers:
        return 0.0
    s = sorted(numbers)
    n = len(s)
    # BUG: picks mid element directly on even length instead of average of two middle elements
    return float(s[n // 2])
