from datetime import date
from age import calculate_age

def test_age():
    b = date(2000, 10, 15)
    c = date(2020, 5, 1)
    assert calculate_age(b, c) == 19

if __name__ == "__main__":
    test_age()
