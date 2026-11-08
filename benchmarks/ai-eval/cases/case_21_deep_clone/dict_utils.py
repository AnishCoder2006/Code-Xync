def deep_merge(dict_a: dict, dict_b: dict) -> dict:
    # BUG: shallow merge overwrites nested dicts instead of recursing
    result = dict(dict_a)
    result.update(dict_b)
    return result
