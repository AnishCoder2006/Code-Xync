def is_valid_hex(hex_str: str) -> bool:
    return hex_str.startswith("#")

def expand_hex_color(hex_str: str) -> str:
    """Expands #fff to #ffffff."""
    hex_str = hex_str.lstrip("#")
    if len(hex_str) == 3:
        # BUG: returns 3-char hex with single characters instead of duplicating
        return "#" + hex_str
    return "#" + hex_str
