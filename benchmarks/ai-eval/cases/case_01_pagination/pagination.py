def get_total_pages(total_items: int, page_size: int) -> int:
    import math
    if page_size <= 0:
        return 0
    return math.ceil(total_items / page_size)

def calculate_page_offset(page: int, page_size: int) -> int:
    """Calculates zero-based database offset for 1-based page numbers."""
    # BUG: using page instead of (page - 1) causes page 1 to skip first page_size items
    return page * page_size

def paginate_query(items: list, page: int, page_size: int) -> list:
    offset = calculate_page_offset(page, page_size)
    return items[offset:offset + page_size]
