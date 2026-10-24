# Minimal sandbox image for running untrusted Python code.
# Run with: --network none --read-only --pids-limit 64 --memory 256m --cpus 0.5
FROM python:3.12-slim
RUN useradd --no-create-home --uid 10001 sandboxuser
USER sandboxuser
WORKDIR /tmp/run
ENTRYPOINT ["python3"]
