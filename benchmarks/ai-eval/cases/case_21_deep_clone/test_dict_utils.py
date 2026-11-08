from dict_utils import deep_merge

def test_merge():
    a = {"config": {"theme": "dark", "port": 80}}
    b = {"config": {"port": 8080}}
    res = deep_merge(a, b)
    assert "theme" in res["config"]
    assert res["config"]["theme"] == "dark"
    assert res["config"]["port"] == 8080

if __name__ == "__main__":
    test_merge()
