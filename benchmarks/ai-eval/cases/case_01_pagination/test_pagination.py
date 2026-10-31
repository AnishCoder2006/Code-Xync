from pagination import calculate_page_offset

def test_page_offset():
    # Page 1 should start at index 0
    assert calculate_page_offset(1, 10) == 0
