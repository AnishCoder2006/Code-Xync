class CacheManager:
    def __init__(self, prefix: str = "app:v1"):
        self.prefix = prefix
        self.store = {}

    def format_key(self, raw_key: str) -> str:
        return f"{self.prefix}:{raw_key}"

    def set(self, key: str, value: str):
        self.store[self.format_key(key)] = value

    def invalidate_cache_key(self, raw_key: str):
        """Removes a key from cache."""
        # BUG: deleting raw_key directly instead of format_key(raw_key)
        self.store.pop(raw_key, None)
