# Attack payload: attempt to write to read-only root filesystem.
# Must fail with Errno 30 (Read-only file system).
with open("/exploit.txt", "w") as f:
    f.write("exploit")
