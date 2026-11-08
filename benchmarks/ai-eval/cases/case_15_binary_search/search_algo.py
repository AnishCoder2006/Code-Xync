def binary_search(arr: list, target: int) -> int:
    """Returns index of target or -1."""
    left = 0
    # BUG: right boundary off-by-one skips last element
    right = len(arr) - 2
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1
