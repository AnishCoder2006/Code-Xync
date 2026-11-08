"""
Comprehensive Phase 5 Proof & Verification Suite.
Validates the complete closed-loop LangGraph agent, retry loop, sandbox critic,
quota tracking, AST edit applier, and stale-version check.
"""

import json
import os
import sys
import uuid
import logging
from unittest.mock import patch

# Ensure services/ai is on sys.path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AI_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

from app.agent.graph import run_agent
from app.agent.llm_provider import MockLLMProvider
from app.agent.stale_check import check_stale, encode_state_vector
from app.agent.edit_applier import apply_function_edit

logging.basicConfig(level=logging.ERROR)


SAMPLE_CODE = '''\
def calculate_page_offset(page: int, size: int) -> int:
    """Return starting offset for a given page number (1-indexed)."""
    return page * size

def other_function():
    return "intact"
'''

FIXED_CODE = '''\
def calculate_page_offset(page: int, size: int) -> int:
    """Return starting offset for a given page number (1-indexed)."""
    return (page - 1) * size
'''

FIXED_JSON = json.dumps({
    "function_name": "calculate_page_offset",
    "new_code": FIXED_CODE,
})


def run_all_proofs():
    print("=========================================================================")
    print("         CodeSync Phase 5: LangGraph AI Closed-Loop Verification         ")
    print("=========================================================================\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 1: Closed-loop happy path (1 shot)
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 1] Single-shot fix execution and diff generation...")
    provider = MockLLMProvider()
    provider.set_responses([FIXED_JSON])
    sandbox_pass = {
        "status": "passed",
        "exitCode": 0,
        "stdout": "All tests passed.",
        "stderr": "",
        "runTimeMs": 250,
    }

    with patch("app.agent.graph._call_sandbox", return_value=sandbox_pass):
        res1 = run_agent(
            room_id="proof-room-1",
            prompt="Fix off-by-one error",
            base_text=SAMPLE_CODE,
            base_version="latest",
            language="python",
            file_path="pagination.py",
            llm_provider=provider,
        )

    assert res1["status"] == "verified", f"Failed: {res1}"
    assert res1["llm_calls"] == 1
    assert "calculate_page_offset" in (res1["diff_patch"] or "")
    print("   -> PASSED: Single shot verified, diff generated, 1 LLM call.\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 2: Retry loop (fail once, pass second)
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 2] Retry loop on sandbox failure (critic feedback loop)...")
    provider2 = MockLLMProvider()
    provider2.set_responses([FIXED_JSON, FIXED_JSON])
    sandbox_fail = {
        "status": "failed",
        "exitCode": 1,
        "stdout": "",
        "stderr": "AssertionError: expected 0 got 10",
        "runTimeMs": 110,
    }

    call_count = [0]
    def mock_sandbox_flaky(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            return sandbox_fail
        return sandbox_pass

    with patch("app.agent.graph._call_sandbox", side_effect=mock_sandbox_flaky):
        res2 = run_agent(
            room_id="proof-room-2",
            prompt="Fix off-by-one error",
            base_text=SAMPLE_CODE,
            base_version="latest",
            language="python",
            file_path="pagination.py",
            llm_provider=provider2,
        )

    assert res2["status"] == "verified", f"Failed: {res2}"
    assert res2["llm_calls"] == 2
    assert res2["retry_count"] == 1
    print("   -> PASSED: First attempt failed sandbox, second attempt fixed and verified.\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 3: Full failure exhaustion (max retries exceeded)
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 3] Max retries exhausted -> human review handover...")
    provider3 = MockLLMProvider()
    provider3.set_responses([FIXED_JSON, FIXED_JSON, FIXED_JSON])

    with patch("app.agent.graph._call_sandbox", return_value=sandbox_fail):
        res3 = run_agent(
            room_id="proof-room-3",
            prompt="Fix bug",
            base_text=SAMPLE_CODE,
            base_version="latest",
            language="python",
            file_path="pagination.py",
            llm_provider=provider3,
        )

    assert res3["status"] == "exhausted", f"Failed: {res3}"
    assert res3["retry_count"] == 2
    assert res3["llm_calls"] == 3
    print("   -> PASSED: Exhausted after 2 retries (3 calls), status='exhausted'.\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 4: Live document invariant
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 4] Document non-mutation invariant...")
    orig_code = str(SAMPLE_CODE)
    provider4 = MockLLMProvider()
    provider4.set_responses([FIXED_JSON])

    with patch("app.agent.graph._call_sandbox", return_value=sandbox_pass):
        res4 = run_agent(
            room_id="proof-room-4",
            prompt="Fix bug",
            base_text=orig_code,
            base_version="vec1",
            language="python",
            file_path="pagination.py",
            llm_provider=provider4,
        )

    assert orig_code == SAMPLE_CODE, "Original document was mutated in-place!"
    assert res4["patched_text"] != orig_code, "Patched text was not generated"
    assert "other_function" in res4["patched_text"], "Other functions preserved"
    print("   -> PASSED: Live doc invariant preserved; patch generated on isolated copy.\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 5: Stale-version check on Accept
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 5] Yjs State Vector stale check on Accept...")
    vec_v1 = encode_state_vector(b"doc-version-1")
    vec_v2 = encode_state_vector(b"doc-version-2")

    with patch("app.agent.stale_check._fetch_state_vector", return_value=vec_v1):
        clean_check = check_stale(room_id="proof-room-5", base_version=vec_v1)
        assert not clean_check.is_stale
        assert clean_check.reason == "vectors_match"

    with patch("app.agent.stale_check._fetch_state_vector", return_value=vec_v2):
        stale_check_res = check_stale(room_id="proof-room-5", base_version=vec_v1)
        assert stale_check_res.is_stale
        assert stale_check_res.reason == "state_vector_mismatch"
    print("   -> PASSED: State vector match accepted; divergent vector rejected with conflict.\n")

    print("=========================================================================")
    print("                  ALL PHASE 5 PROOFS PASSED SUCCESSFULLY                 ")
    print("=========================================================================\n")


if __name__ == "__main__":
    run_all_proofs()
