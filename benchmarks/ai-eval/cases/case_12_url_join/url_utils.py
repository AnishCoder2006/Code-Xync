def clean_query(query: str) -> str:
    return query.strip("?")

def join_url_path(base: str, path: str) -> str:
    """Joins URL base and path without duplicate slashes."""
    # BUG: simple concatenation produces double slash
    return base + "/" + path
