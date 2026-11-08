from fizzbuzz import custom_fizzbuzz

def test_fb():
    assert custom_fizzbuzz(15) == "FizzBuzz"
    assert custom_fizzbuzz(9) == "Fizz"

if __name__ == "__main__":
    test_fb()
