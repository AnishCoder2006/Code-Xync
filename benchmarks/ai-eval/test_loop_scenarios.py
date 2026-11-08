"""
Verification suite for Item 2: Loop tests through real API/worker sandbox.
Scenarios:
  (a) Mock returns a wrong fix first, then a correct one:
      Show test failure fed back and final status `verified`.
  (b) Mock returns only wrong fixes:
      Show `exhausted` and the document unchanged.
  (c) /ai/fix with NO test_command:
      Show result is labeled `unverified_no_test`, not verified.
"""

import os
import sys
import json
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AI_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "services", "ai"))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

os.environ["SANDBOX_URL"] = "http://localhost:4000/execution/sandbox"
os.environ["INTERNAL_API_SECRET"] = "codesync-internal-ai-secret"

from app.agent.graph import run_agent
from app.agent.llm_provider import MockLLMProvider

INITIAL_CODE = '''\
def calculate_total(price: int, tax: int) -> int:
    """Calculate price plus tax."""
    return price - tax  # BUG
'''

WRONG_FIX_1 = '''\
def calculate_total(price: int, tax: int) -> int:
    """Calculate price plus tax."""
    return price * tax
'''

WRONG_FIX_2 = '''\
def calculate_total(price: int, tax: int) -> int:
    """Calculate price plus tax."""
    return price // tax
'''

CORRECT_FIX = '''\
def calculate_total(price: int, tax: int) -> int:
    """Calculate price plus tax."""
    return price + tax
'''

TEST_SCRIPT = '''\
import main
assert main.calculate_total(100, 15) == 115
print("PASS_ASSERTION")
'''

def run_scenario_a():
    print("-------------------------------------------------------------------------")
    print("  Scenario 2(a): Wrong Fix First -> Error Feedback -> Correct Fix       ")
    print("-------------------------------------------------------------------------")

    provider = MockLLMProvider()
    provider.set_responses([
        {"function_name": "calculate_total", "new_code": WRONG_FIX_1},
        {"function_name": "calculate_total", "new_code": CORRECT_FIX},
    ])

    res = run_agent(
        room_id="loop-test-2a",
        prompt="Fix subtraction bug in calculate_total",
        base_text=INITIAL_CODE,
        base_version="latest",
        language="python",
        file_path="main.py",
        test_command=["python3", "test_main.py"],
        extra_files={"test_main.py": TEST_SCRIPT},
        llm_provider=provider,
    )

    print(f"   Total LLM calls made: {res.get('llm_calls')}")
    print(f"   Final status: '{res.get('status')}' (expected: 'verified')")

    # Check the call history of the provider to inspect the feedback given in call 2
    history = provider.call_history
    assert len(history) == 2, f"Expected 2 LLM calls, got {len(history)}"

    retry_prompt = history[1][-1]["content"]
    print("   [Feedback to LLM on Attempt 2]:")
    for line in retry_prompt.splitlines()[:10]:
        print(f"     | {line}")

    assert "AssertionError" in retry_prompt or "SANDBOX ERROR" in retry_prompt, "Feedback did not contain sandbox error"
    assert res.get("status") == "verified", f"Expected verified, got {res.get('status')}"
    assert "return price + tax" in (res.get("new_code") or "")
    print("   -> PASS Scenario 2(a): Failure fed back to LLM; final status is verified.\n")


def run_scenario_b():
    print("-------------------------------------------------------------------------")
    print("  Scenario 2(b): Scripted Wrong Fixes Only -> Exhausted & Doc Intact     ")
    print("-------------------------------------------------------------------------")

    # Seed document in Sync Service
    room_id = "loop-test-2b-exhausted"
    sync_url = "http://localhost:4001"
    secret = "codesync-internal-ai-secret"

    # Step 1: Connect or seed initial document text in sync service via /apply-patch or WebSocket
    # For a clean test, let's capture doc text via sync service
    # Since sync service creates room on demand via loadRoomPersistence or state:
    req = urllib.request.Request(
        f"{sync_url}/room/{room_id}/state",
        headers={"x-internal-secret": secret}
    )
    with urllib.request.urlopen(req) as resp:
        state_data = json.loads(resp.read().decode())
        doc_before = state_data.get("content", "")

    # If empty, let's insert initial code via /apply-patch
    req_seed = urllib.request.Request(
        f"{sync_url}/room/{room_id}/apply-patch",
        data=json.dumps({"startOffset": 0, "deleteLength": 0, "newCode": INITIAL_CODE}).encode(),
        headers={"Content-Type": "application/json", "x-internal-secret": secret}
    )
    with urllib.request.urlopen(req_seed) as resp:
        seed_data = json.loads(resp.read().decode())
        doc_initial = seed_data.get("content", "")

    print(f"   Initial Sync Service document content length: {len(doc_initial)}")

    # Provider that only returns wrong fixes
    provider = MockLLMProvider()
    provider.set_responses([
        {"function_name": "calculate_total", "new_code": WRONG_FIX_1},
        {"function_name": "calculate_total", "new_code": WRONG_FIX_2},
        {"function_name": "calculate_total", "new_code": WRONG_FIX_1},
        {"function_name": "calculate_total", "new_code": WRONG_FIX_2},
    ])

    res = run_agent(
        room_id=room_id,
        prompt="Fix subtraction bug in calculate_total",
        base_text=doc_initial,
        base_version="latest",
        language="python",
        file_path="main.py",
        test_command=["python3", "test_main.py"],
        extra_files={"test_main.py": TEST_SCRIPT},
        llm_provider=provider,
    )

    print(f"   Total LLM calls made: {res.get('llm_calls')}")
    print(f"   Final status: '{res.get('status')}' (expected: 'exhausted')")
    print(f"   Error message: '{res.get('error_message')}'")

    assert res.get("status") == "exhausted", f"Expected exhausted, got {res.get('status')}"

    # Verify sync service document was NOT changed
    req_check = urllib.request.Request(
        f"{sync_url}/room/{room_id}/text",
        headers={"x-internal-secret": secret}
    )
    with urllib.request.urlopen(req_check) as resp:
        text_data = json.loads(resp.read().decode())
        doc_after = text_data.get("content", "")

    print(f"   Document content after exhausted loop: {len(doc_after)} bytes")
    assert doc_after == doc_initial, "Document in Sync service was modified during failed fix loop!"
    print("   -> PASS Scenario 2(b): Returned 'exhausted'; document in Sync service untouched.\n")


def run_scenario_c():
    print("-------------------------------------------------------------------------")
    print("  Scenario 2(c): /ai/fix with NO test_command -> unverified_no_test      ")
    print("-------------------------------------------------------------------------")

    provider = MockLLMProvider()
    provider.set_responses([
        {"function_name": "calculate_total", "new_code": CORRECT_FIX},
    ])

    res = run_agent(
        room_id="loop-test-2c-no-test",
        prompt="Fix subtraction bug without test",
        base_text=INITIAL_CODE,
        base_version="latest",
        language="python",
        file_path="main.py",
        test_command=[],  # NO TEST COMMAND
        llm_provider=provider,
    )

    status = res.get("status")
    print(f"   Run with test_command=[]: status = '{status}' (expected: 'unverified_no_test')")
    assert status == "unverified_no_test", f"Expected 'unverified_no_test', got '{status}'"
    assert status != "verified", "Must NOT be labeled verified without test"

    print("   -> PASS Scenario 2(c): Correctly labeled 'unverified_no_test', not 'verified'.\n")


if __name__ == "__main__":
    print("=========================================================================")
    print("             CodeSync Phase 5: Verification of Item 2 Loop Tests         ")
    print("=========================================================================\n")
    run_scenario_a()
    run_scenario_b()
    run_scenario_c()
    print("=========================================================================")
    print("            ALL ITEM 2 LOOP SCENARIOS PASSED SUCCESSFULLY                ")
    print("=========================================================================")

