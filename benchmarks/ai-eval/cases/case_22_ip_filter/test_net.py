from net import is_private_ip

def test_ip():
    assert is_private_ip("192.168.1.1") is True
    assert is_private_ip("8.8.8.8") is False

if __name__ == "__main__":
    test_ip()
