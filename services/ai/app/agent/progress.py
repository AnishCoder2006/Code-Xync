"""
Progress events for one fix run (plan step 1.2).

Published to Redis so the API can stream them to the browser as SSE
(GET /ai/progress/:progressId). Protocol and key layout are documented in
services/api/src/lib/aiProgress.ts; the Lua script below must stay identical to
PUBLISH_SCRIPT there, so both publishers share one seq counter and one ordering.

Publishing never raises: if Redis is unavailable the fix loop runs unchanged.
"""

import json
import logging
import os
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

PROGRESS_TTL_S = 900
TERMINAL_STEPS = ("done", "failed")

# KEYS: seq, log, channel, done   ARGV: event JSON without seq, ttl, onlyIfOpen, isTerminal
PUBLISH_SCRIPT = """
if ARGV[3] == '1' and redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
local seq = redis.call('INCR', KEYS[1])
local ev = '{"seq":' .. seq .. ',' .. string.sub(ARGV[1], 2)
redis.call('RPUSH', KEYS[2], ev)
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
if ARGV[4] == '1' then redis.call('SET', KEYS[4], '1', 'EX', ARGV[2]) end
redis.call('PUBLISH', KEYS[3], ev)
return seq
"""

_client = None
_script = None


def _get_script():
    global _client, _script
    if _script is None:
        import redis

        _client = redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6380"), decode_responses=True)
        _script = _client.register_script(PUBLISH_SCRIPT)
    return _script


class ProgressPublisher:
    """Publishes the steps of one fix run. A publisher without an id does nothing."""

    def __init__(self, progress_id: Optional[str]):
        self.progress_id = progress_id
        self._broken = False

    def emit(self, step: str, **fields: Any) -> None:
        if not self.progress_id or self._broken:
            return
        pid = self.progress_id
        event = {"step": step, **{k: v for k, v in fields.items() if v is not None}, "ts": int(time.time() * 1000)}
        try:
            _get_script()(
                keys=[f"ai:progress:{pid}:seq", f"ai:progress:{pid}:log", f"ai:progress:{pid}", f"ai:progress:{pid}:done"],
                args=[json.dumps(event), str(PROGRESS_TTL_S), "1", "1" if step in TERMINAL_STEPS else "0"],
            )
        except Exception as exc:  # progress is best effort; the fix must not fail because of it
            self._broken = True
            logger.warning("progress publish failed for %s (further events dropped): %s", pid, exc)
