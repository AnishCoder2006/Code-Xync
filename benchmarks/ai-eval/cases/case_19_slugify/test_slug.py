from slug import slugify_string

def test_slug():
    assert slugify_string("Hello, World! -- 2026") == "hello-world-2026"

if __name__ == "__main__":
    test_slug()
