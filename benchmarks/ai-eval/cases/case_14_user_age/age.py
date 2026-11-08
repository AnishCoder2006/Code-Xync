from datetime import date

def calculate_age(birth_date: date, current_date: date) -> int:
    """Calculates age in years."""
    # BUG: simply subtracting years without checking month/day
    return current_date.year - birth_date.year
