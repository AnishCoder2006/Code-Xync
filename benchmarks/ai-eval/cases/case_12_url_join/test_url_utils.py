from url_utils import join_url_path

def test_url_join():
    assert join_url_path("https://api.com/", "/v1/users") == "https://api.com/v1/users"

if __name__ == "__main__":
    test_url_join()
