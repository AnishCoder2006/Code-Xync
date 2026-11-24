# One small image for the script languages: Bash, Perl, Lua 5.4.
# Hardening flags come from the worker (hardening.ts).
FROM alpine:3.20
RUN apk add --no-cache bash perl lua5.4 && adduser -D -H -u 10001 sandboxuser
USER sandboxuser
WORKDIR /tmp/run
ENTRYPOINT ["bash"]
