from cookie import parse_cookie_header

def test_cookie():
    res = parse_cookie_header("session=abc; user=alice ; role=admin")
    assert "user" in res
    assert res["user"] == "alice"

if __name__ == "__main__":
    test_cookie()
