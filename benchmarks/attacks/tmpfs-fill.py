# Attack payload: fill /tmp until out of space (16MB tmpfs limit).
# Must fail with Errno 28 (No space left on device).
with open("/tmp/fill.bin", "wb") as f:
    while True:
        f.write(b"x" * 1024 * 1024)
