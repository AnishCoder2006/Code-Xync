from text_utils import truncate_text

def test_truncate():
    res = truncate_text("hello world long text", max_len=8)
    assert len(res) <= 8

if __name__ == "__main__":
    test_truncate()
