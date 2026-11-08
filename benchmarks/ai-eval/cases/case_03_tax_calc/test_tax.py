from tax import compute_sales_tax

def test_sales_tax():
    assert compute_sales_tax(10.99, "NY") == 0.98

if __name__ == "__main__":
    test_sales_tax()
