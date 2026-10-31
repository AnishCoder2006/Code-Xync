from tax import compute_sales_tax

def test_sales_tax():
    # 10.99 * 0.08875 = 0.9753625 -> should round to 0.98
    assert compute_sales_tax(10.99, "NY") == 0.98
