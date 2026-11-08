from cache import CacheManager

def test_invalidation():
    cm = CacheManager("test")
    cm.set("user:10", "alice")
    cm.invalidate_cache_key("user:10")
    assert "test:user:10" not in cm.store

if __name__ == "__main__":
    test_invalidation()
