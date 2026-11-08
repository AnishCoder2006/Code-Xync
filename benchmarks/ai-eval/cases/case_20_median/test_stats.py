from stats import calculate_median

def test_median():
    assert calculate_median([1, 2, 3, 4]) == 2.5

if __name__ == "__main__":
    test_median()
