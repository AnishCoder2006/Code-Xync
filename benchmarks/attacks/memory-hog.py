# Attack payload: unbounded memory allocation. Must be killed by the 256MB cgroup limit.
data = []
while True:
    data.append("x" * 10_000_000)
