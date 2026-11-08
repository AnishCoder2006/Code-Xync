from semver import compare_semver

def test_semver():
    # "1.10.0" is newer than "1.2.0", so compare_semver("1.2.0", "1.10.0") should be -1
    assert compare_semver("1.2.0", "1.10.0") == -1

if __name__ == "__main__":
    test_semver()
