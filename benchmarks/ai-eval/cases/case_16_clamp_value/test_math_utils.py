from math_utils import clamp_val

def test_clamp():
    assert clamp_val(15, 0, 10) == 10
    assert clamp_val(-5, 0, 10) == 0

if __name__ == "__main__":
    test_clamp()
