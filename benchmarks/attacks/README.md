# Attack payload suite
Run each payload through the sandbox and confirm it is contained per design doc 3.1/3.3.
CI should fail the build if any payload escapes its limit.
| Payload | Expected result |
|---|---|
| fork-bomb.sh | Killed by --pids-limit |
| infinite-output.py | Truncated/killed at output cap |
| memory-hog.py | OOM-killed at 256MB |
| network-call.py | Fails — no network |
| read-sensitive-file.py | Fails — no host FS access |
| sleep-beyond-timeout.py | Killed at 5s timeout |
