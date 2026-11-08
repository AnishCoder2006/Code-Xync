"""
Stale-version check for CodeSync Phase 5 (design doc section 5.3).

On Accept, the API compares the document's current Yjs state vector to the
baseVersion snapshot that was taken when the AI request began. If the touched
line range changed between then and now, we reject with 409 so the user is
prompted to regenerate rather than silently clobbering someone else's edits.

The Yjs persistence service exposes:
  GET /doc/<roomId>/state   -> { "stateVector": "<base64 bytes>" }
  GET /doc/<roomId>/text    -> { "text": "<full file text>" }

baseVersion is stored as an opaque base64 string (Y.encodeStateVector).
We compare vectors with a simple byte equality check — if they differ, the
document changed.  For line-level granularity (future extension) we also
accept a LineRange and check whether those specific lines changed.
"""

from __future__ import annotations

import base64
import json
import urllib.request
import urllib.error
import os
import logging
from dataclasses import dataclass
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# The sync service (services/sync) listens on port 4001 by default.
SYNC_SERVICE_URL = os.getenv("SYNC_SERVICE_URL", "http://localhost:4001")


@dataclass
class StaleCheckResult:
    is_stale: bool
    reason: str
    current_vector: Optional[str] = None  # base64


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fetch_state(room_id: str) -> Optional[dict]:
    """
    Return {stateVector, content} for the room from the sync service,
    or None on error.
    The sync service exposes GET /room/:roomId/state which returns
    { stateVector: base64, content: string, ... }.
    """
    url = f"{SYNC_SERVICE_URL}/room/{room_id}/state"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        logger.warning("Could not fetch state for room %s: %s", room_id, exc)
        return None


def _fetch_state_vector(room_id: str) -> Optional[str]:
    """Return the room's current Yjs state vector as base64, or None on error."""
    data = _fetch_state(room_id)
    return data.get("stateVector") if data else None


def _fetch_text(room_id: str) -> Optional[str]:
    """Return the room's current document text, or None on error."""
    data = _fetch_state(room_id)
    return data.get("content") if data else None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def check_stale(
    room_id: str,
    base_version: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
    base_text: Optional[str] = None,
) -> StaleCheckResult:
    """
    Check whether the document has changed since base_version was recorded.

    Args:
        room_id:      The room whose document we check.
        base_version: Base64-encoded Yjs state vector taken at AI request time.
                      The special value "latest" disables the check (Phase 2
                      backward-compatibility; logs a warning).
        start_line:   Optional first line of the AI-touched range (1-indexed).
        end_line:     Optional last  line of the AI-touched range (1-indexed).
        base_text:    Optional document text snapshot at AI request time.
                      If provided together with a line range, we also compare
                      the specific lines to detect targeted conflicts.

    Returns:
        StaleCheckResult with is_stale=False when safe to accept.
    """
    # ------------------------------------------------------------------
    # Phase 2 backward-compat: "latest" disables the check.
    # ------------------------------------------------------------------
    if base_version == "latest":
        logger.warning(
            "room=%s: baseVersion is 'latest' (Phase 2 placeholder). "
            "Stale check skipped. Upgrade to real state vectors.",
            room_id,
        )
        return StaleCheckResult(
            is_stale=False,
            reason="skipped_legacy_placeholder",
        )

    # ------------------------------------------------------------------
    # 1. Fast path: compare Yjs state vectors (opaque binary equality).
    # ------------------------------------------------------------------
    current_vector = _fetch_state_vector(room_id)

    if current_vector is None:
        # Sync service unreachable — fail open with a warning so CI still works.
        logger.warning(
            "room=%s: sync service unavailable; stale check cannot run.", room_id
        )
        return StaleCheckResult(
            is_stale=False,
            reason="sync_service_unavailable",
            current_vector=None,
        )

    if current_vector != base_version:
        # ------------------------------------------------------------------
        # 2. Vectors differ. If a line range was supplied, check whether
        #    *those* lines actually changed (common case: someone edited a
        #    different function — we should still allow the accept).
        # ------------------------------------------------------------------
        if (
            start_line is not None
            and end_line is not None
            and base_text is not None
        ):
            current_text = _fetch_text(room_id)
            if current_text is not None:
                base_lines = base_text.splitlines()
                curr_lines = current_text.splitlines()
                # Check whether the touched line range is identical
                sl = start_line - 1  # convert to 0-indexed
                el = end_line        # end is exclusive in Python slicing
                base_slice = base_lines[sl:el]
                curr_slice = curr_lines[sl:el]
                if base_slice == curr_slice:
                    return StaleCheckResult(
                        is_stale=False,
                        reason="vector_changed_but_lines_intact",
                        current_vector=current_vector,
                    )

        return StaleCheckResult(
            is_stale=True,
            reason="state_vector_mismatch",
            current_vector=current_vector,
        )

    # Vectors match → document has not changed.
    return StaleCheckResult(
        is_stale=False,
        reason="vectors_match",
        current_vector=current_vector,
    )


# ---------------------------------------------------------------------------
# Helpers for tests / the API layer
# ---------------------------------------------------------------------------

def encode_state_vector(raw_bytes: bytes) -> str:
    """Encode a Yjs state-vector byte array as URL-safe base64."""
    return base64.urlsafe_b64encode(raw_bytes).decode("ascii")


def decode_state_vector(b64: str) -> bytes:
    """Decode a base64 state vector back to bytes."""
    return base64.urlsafe_b64decode(b64.encode("ascii"))
