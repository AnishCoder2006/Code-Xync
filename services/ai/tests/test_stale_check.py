"""
Tests for stale_check.py (Phase 5).
Verifies state vector comparison and targeted line-range conflict detection on Accept.
"""

from unittest.mock import patch
from app.agent.stale_check import (
    check_stale,
    encode_state_vector,
    decode_state_vector,
)


def test_encode_decode_state_vector():
    raw = b"\x01\x02\x03\x04test_vector"
    encoded = encode_state_vector(raw)
    decoded = decode_state_vector(encoded)
    assert decoded == raw


def test_check_stale_legacy_latest_skips():
    res = check_stale(room_id="room-1", base_version="latest")
    assert not res.is_stale
    assert res.reason == "skipped_legacy_placeholder"


def test_check_stale_vectors_match():
    vec = encode_state_vector(b"v1")
    with patch("app.agent.stale_check._fetch_state_vector", return_value=vec):
        res = check_stale(room_id="room-1", base_version=vec)
        assert not res.is_stale
        assert res.reason == "vectors_match"
        assert res.current_vector == vec


def test_check_stale_vectors_mismatch_without_lines():
    vec_v1 = encode_state_vector(b"v1")
    vec_v2 = encode_state_vector(b"v2")
    with patch("app.agent.stale_check._fetch_state_vector", return_value=vec_v2):
        res = check_stale(room_id="room-1", base_version=vec_v1)
        assert res.is_stale
        assert res.reason == "state_vector_mismatch"
        assert res.current_vector == vec_v2


def test_check_stale_vectors_mismatch_lines_intact():
    vec_v1 = encode_state_vector(b"v1")
    vec_v2 = encode_state_vector(b"v2")

    base_text = "line1\ndef foo():\n    return 1\nline4"
    # An edit happened on line 1, but foo() on lines 2-3 is intact
    current_text = "line1_edited\ndef foo():\n    return 1\nline4"

    with patch("app.agent.stale_check._fetch_state_vector", return_value=vec_v2), \
         patch("app.agent.stale_check._fetch_text", return_value=current_text):
        res = check_stale(
            room_id="room-1",
            base_version=vec_v1,
            start_line=2,
            end_line=3,
            base_text=base_text,
        )
        assert not res.is_stale
        assert res.reason == "vector_changed_but_lines_intact"


def test_check_stale_vectors_mismatch_lines_modified():
    vec_v1 = encode_state_vector(b"v1")
    vec_v2 = encode_state_vector(b"v2")

    base_text = "line1\ndef foo():\n    return 1\nline4"
    current_text = "line1\ndef foo():\n    return 999\nline4"

    with patch("app.agent.stale_check._fetch_state_vector", return_value=vec_v2), \
         patch("app.agent.stale_check._fetch_text", return_value=current_text):
        res = check_stale(
            room_id="room-1",
            base_version=vec_v1,
            start_line=2,
            end_line=3,
            base_text=base_text,
        )
        assert res.is_stale
        assert res.reason == "state_vector_mismatch"


def test_check_stale_sync_service_unavailable():
    vec_v1 = encode_state_vector(b"v1")
    with patch("app.agent.stale_check._fetch_state_vector", return_value=None):
        res = check_stale(room_id="room-1", base_version=vec_v1)
        assert not res.is_stale
        assert res.reason == "sync_service_unavailable"
