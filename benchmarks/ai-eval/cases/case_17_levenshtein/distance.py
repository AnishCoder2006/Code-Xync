def levenshtein_distance(s1: str, s2: str) -> int:
    # BUG: returns length difference only instead of edit distance
    return abs(len(s1) - len(s2))
