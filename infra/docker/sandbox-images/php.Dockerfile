# Sandbox image for untrusted PHP (CLI) code. Hardening flags come from the worker (hardening.ts).
FROM php:8.3-cli-alpine
RUN adduser -D -H -u 10001 sandboxuser
USER sandboxuser
WORKDIR /tmp/run
ENTRYPOINT ["php"]
