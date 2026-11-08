def parse_cookie_header(header: str) -> dict:
    cookies = {}
    if not header:
        return cookies
    for part in header.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            # BUG: misses trimming leading/trailing whitespace
            cookies[k] = v
    return cookies
