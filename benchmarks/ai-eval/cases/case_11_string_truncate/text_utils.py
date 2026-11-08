def truncate_text(text: str, max_len: int = 10) -> str:
    """Truncates text and appends ... if longer than max_len."""
    if len(text) <= max_len:
        return text
    # BUG: text[:max_len] + "..." has total length max_len + 3
    return text[:max_len] + "..."

def count_words(text: str) -> int:
    return len(text.split())
