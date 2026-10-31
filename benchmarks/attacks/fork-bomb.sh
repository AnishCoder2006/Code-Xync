#!/bin/sh
# Attack payload: fork bomb. Must be contained by --pids-limit (design doc 3.1).
# Continuously forks in a tight loop. The --pids-limit flag must prevent runaway
# process creation. The container should either timeout or fail with
# "Resource temporarily unavailable" on stderr.
bomb() { bomb | bomb & }
bomb
# Keep the parent alive so the container doesn't exit 0 before the limit is hit
while true; do sleep 1; done
