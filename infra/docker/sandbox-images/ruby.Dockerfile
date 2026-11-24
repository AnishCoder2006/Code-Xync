# Sandbox image for untrusted Ruby code. Hardening flags come from the worker (hardening.ts).
FROM ruby:3.3-slim
RUN useradd --no-create-home --uid 10001 sandboxuser
USER sandboxuser
WORKDIR /tmp/run
ENTRYPOINT ["ruby"]
