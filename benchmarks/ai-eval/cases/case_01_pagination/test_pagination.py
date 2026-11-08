from pagination import calculate_page_offset

def test_page_offset():
    assert calculate_page_offset(1, 10) == 0

if __name__ == "__main__":
    test_page_offset()
