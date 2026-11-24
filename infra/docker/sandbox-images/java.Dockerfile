# Sandbox image for untrusted Java: single-file source launch (`java Main.java`) compiles in
# memory, so nothing is written or executed from disk (/tmp stays noexec).
# Hardening flags come from the worker (hardening.ts).
FROM eclipse-temurin:21-jdk-alpine
RUN adduser -D -H -u 10001 sandboxuser
USER sandboxuser
WORKDIR /tmp/run
ENTRYPOINT ["java"]
