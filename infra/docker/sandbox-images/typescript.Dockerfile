# Sandbox image for untrusted TypeScript: Node 22 runs .ts directly (type stripping /
# transform), no compiler step and no writable build dir. Same hardening flags as the others:
# --network none --read-only --pids-limit 64 --memory 256m --cpus 0.5 (worker hardening.ts).
FROM node:22-slim
RUN useradd --no-create-home --uid 10001 sandboxuser
USER sandboxuser
WORKDIR /tmp/run
ENTRYPOINT ["node", "--experimental-transform-types", "--no-warnings"]
