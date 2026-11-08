def is_private_ip(ip_str: str) -> bool:
    # BUG: checks only 10.x.x.x, misses 192.168.x.x and 172.16.x.x
    return ip_str.startswith("10.")
