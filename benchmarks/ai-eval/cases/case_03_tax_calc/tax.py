def get_tax_rate(state_code: str) -> float:
    rates = {"NY": 0.08875, "CA": 0.0725, "TX": 0.0625}
    return rates.get(state_code.upper(), 0.05)

def compute_sales_tax(subtotal: float, state_code: str) -> float:
    """Computes rounded tax in cents."""
    rate = get_tax_rate(state_code)
    raw_tax = subtotal * rate
    # BUG: int truncation loses fractional cents instead of round half-up
    return int(raw_tax * 100) / 100.0

def generate_invoice_total(subtotal: float, state_code: str) -> float:
    tax = compute_sales_tax(subtotal, state_code)
    return round(subtotal + tax, 2)
