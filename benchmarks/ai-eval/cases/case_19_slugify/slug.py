import re

def slugify_string(text: str) -> str:
    # BUG: forgets to strip leading/trailing hyphens and lowercase
    return re.sub(r"[^a-zA-Z0-9]+", "-", text)
