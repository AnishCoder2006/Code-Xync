from search_algo import binary_search

def test_search():
    assert binary_search([1, 3, 5, 7, 9], 9) == 4

if __name__ == "__main__":
    test_search()
