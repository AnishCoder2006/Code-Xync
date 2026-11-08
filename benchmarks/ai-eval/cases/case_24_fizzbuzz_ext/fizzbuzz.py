def custom_fizzbuzz(n: int) -> str:
    # BUG: checks 3 before 15, returning Fizz instead of FizzBuzz
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    if n % 15 == 0:
        return "FizzBuzz"
    return str(n)
