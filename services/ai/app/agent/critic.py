"""
Critic evaluation for CodeSync Phase 5 sandbox results.
See design doc section 5.2 step 6.
Evaluates:
- Pass: exitCode == 0, status == "passed", reproducing test (if present) passed.
- Fail: exitCode != 0 or status != "passed", extracts error/stack trace for feedback to LLM.
"""

from typing import Dict, Any, Optional


def evaluate_sandbox_result(
    sandbox_result: Dict[str, Any],
    has_reproducing_test: bool = False,
) -> Dict[str, Any]:
    """
    Evaluates sandbox execution result.
    Returns:
        {
            "passed": bool,
            "error_feedback": Optional[str],
            "reason": str
        }
    """
    if not sandbox_result:
        return {
            "passed": False,
            "error_feedback": "Sandbox execution produced no result",
            "reason": "empty_result"
        }

    status = sandbox_result.get("status", "failed")
    exit_code = sandbox_result.get("exitCode")
    if exit_code is None:
        exit_code = sandbox_result.get("code", 1)

    stdout = sandbox_result.get("stdout", "")
    stderr = sandbox_result.get("stderr", "")

    # Clean execution pass check
    if status == "passed" and exit_code == 0:
        return {
            "passed": True,
            "error_feedback": None,
            "reason": "clean_exit"
        }

    # Extract relevant error text to feed back to LLM
    error_msg = ""
    if stderr and stderr.strip():
        # Keep up to 2000 chars of stack trace / assertion failure
        error_msg = stderr.strip()[-2000:]
    elif stdout and stdout.strip():
        error_msg = stdout.strip()[-2000:]
    else:
        error_msg = f"Process exited with non-zero exit code: {exit_code} (status: {status})"

    return {
        "passed": False,
        "error_feedback": error_msg,
        "reason": f"exit_code_{exit_code}"
    }
