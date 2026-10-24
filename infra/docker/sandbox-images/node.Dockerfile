# Minimal sandbox image for running untrusted Node.js code.
# Run with: --network none --read-only --pids-limit 64 --memory 256m --cpus 0.5
FROM node:20-slim
RUN useradd --no-create-home --uid 10001 sandboxuser
USER sandboxuser
WORKDIR /tmp/run
ENTRYPOINT ["node"]
