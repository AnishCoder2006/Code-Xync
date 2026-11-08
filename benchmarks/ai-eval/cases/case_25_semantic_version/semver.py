def compare_semver(v1: str, v2: str) -> int:
    # BUG: compares version components as strings lexicographically ("2" > "10")
    t1 = tuple(v1.split("."))
    t2 = tuple(v2.split("."))
    if t1 < t2:
        return -1
    elif t1 > t2:
        return 1
    return 0
