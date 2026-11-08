from distance import levenshtein_distance

def test_dist():
    assert levenshtein_distance("kitten", "sitting") == 3

if __name__ == "__main__":
    test_dist()
