def clamp_val(val: float, min_val: float, max_val: float) -> float:
    """Clamps val within [min_val, max_val]."""
    # BUG: inverts min and max boundary checks
    if val < min_val:
        return max_val
    if val > max_val:
        return min_val
    return val
