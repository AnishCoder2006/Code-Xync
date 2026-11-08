from color import expand_hex_color

def test_expand():
    assert expand_hex_color("#abc") == "#aabbcc"

if __name__ == "__main__":
    test_expand()
