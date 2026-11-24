"""
LangGraph closed-loop agent for CodeSync Phase 5.
Design doc sections 5.1-5.2.

Flow:
  context_builder
       |
  generate_fix          (LLM call; builds function-level diff on a COPY)
       |
  apply_edit            (edit_applier.apply_function_edit on the copy)
       |
  sandbox_test          (calls worker via HTTP; same hardened Docker limits)
       |
  critic                (evaluate_sandbox_result)
       |
  ┌── passed? ──────────> finish ──> END
  └── failed?
        |
     retries < MAX_RETRIES?
        yes ──> generate_fix  (with error feedback injected into prompt)
        no  ──> finish ──> END (status "exhausted")

INVARIANT (enforced, never bypassed):
  The live Yjs document is NEVER touched by this agent.
  All edits happen on `working_content` (a copy of the snapshot text).
  Only a human click on Accept — after a stale-version check in the API — can
  modify the live doc.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, TypedDict

from langgraph.graph import StateGraph, END

from app.agent.edit_applier import apply_function_edit, ApplyResult
from app.agent.critic import evaluate_sandbox_result
from app.agent.llm_provider import get_llm_provider, BaseLLMProvider, LLMResponse, wrap_untrusted_code
from app.agent.progress import ProgressPublisher
from app.agent.languages import default_command

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_RETRIES = 2          # Maximum LLM regeneration attempts after sandbox failure
API_SERVICE_URL = os.getenv("API_SERVICE_URL", "http://localhost:4000")
SANDBOX_URL = os.getenv("SANDBOX_URL", f"{API_SERVICE_URL}/execution/sandbox")


# ---------------------------------------------------------------------------
# Graph state
# ---------------------------------------------------------------------------

class AgentState(TypedDict, total=False):
    # ── Inputs (set once at entry) ──────────────────────────────────────────
    room_id: str
    prompt: str
    language: str
    file_path: str
    base_text: str           # full snapshot of the file at request time
    base_version: str        # Yjs state vector (base64) at request time
    test_command: List[str]  # optional test command to run after edit
    extra_files: Optional[Dict[str, str]]  # optional extra files mounted alongside target file
    llm_provider: Optional[Any]   # injected for tests; None = use get_llm_provider()
    progress: Optional[Any]       # ProgressPublisher; emits steps for the UI (no-op without an id)

    # ── Working state ───────────────────────────────────────────────────────
    working_content: str     # copy of base_text that the agent edits (NEVER the live doc)
    function_name: str       # function to replace (parsed from LLM response)
    new_code: str            # replacement code from LLM
    apply_result: Optional[dict]    # serialised ApplyResult
    sandbox_result: Optional[dict]  # raw result from sandbox
    critic_result: Optional[dict]   # from evaluate_sandbox_result
    retry_count: int
    error_feedback: Optional[str]   # fed back to LLM on retry

    # ── Metrics ─────────────────────────────────────────────────────────────
    llm_calls: int
    total_cost_usd: float
    total_latency_ms: float

    # ── Output ──────────────────────────────────────────────────────────────
    # Note: final_status is populated by node_finish; it shadows the initial
    # default so we use a separate key to avoid confusion.
    final_status: Optional[str]    # "verified" | "exhausted" | "apply_error" | "error"
    diff_patch: Optional[str]
    function_name_out: Optional[str]
    start_line: Optional[int]
    end_line: Optional[int]
    error_message: Optional[str]
    llm_responses: List[dict]  # audit trail of every LLM response

    # ── Internal flags ───────────────────────────────────────────────────────
    _hard_error: bool          # set when an unrecoverable error occurs mid-graph
    _hard_error_msg: Optional[str]


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are an expert software engineer fixing a bug in code.
Output ONLY a JSON object with:
"function_name": the name of the function in the file to fix
"new_code": the full replacement function including signature and body

Example:
{"function_name": "my_function", "new_code": "def my_function(x):\\n    return x + 1"}
Do not output markdown code blocks or text outside the JSON.
"""


def _build_initial_messages(
    prompt: str,
    language: str,
    file_path: str,
    file_content: str,
) -> List[Dict[str, str]]:
    import re
    if language == "python":
        fn_names = re.findall(r"def\s+([a-zA-Z0-9_]+)\s*\(", file_content)
    else:
        raw_matches = re.findall(r"(?:function\s+([a-zA-Z0-9_]+)|([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)", file_content)
        fn_names = [m[0] or m[1] for m in raw_matches if m[0] or m[1]]
    fn_hint = f"\nCandidate functions in file: {fn_names}. You must set \"function_name\" to the exact function from this list being modified.\n" if fn_names else ""

    user_content = (
        f"Language: {language}\n"
        f"File: {file_path}\n\n"
        f"Task: {prompt}\n\n"
        f"{wrap_untrusted_code(file_content, 'SOURCE FILE')}\n"
        f"{fn_hint}\n"
        "Respond with ONLY a valid JSON object with keys \"function_name\" and \"new_code\"."
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": user_content},
    ]


def _build_retry_messages(
    messages: List[Dict[str, str]],
    previous_new_code: str,
    error_feedback: str,
    language: str,
    file_path: str,
) -> List[Dict[str, str]]:
    retry_msg = (
        f"Your previous fix was rejected by the sandbox. Error output:\n"
        f"{wrap_untrusted_code(error_feedback, 'SANDBOX ERROR')}\n\n"
        f"Previous code you wrote:\n"
        f"{wrap_untrusted_code(previous_new_code, 'YOUR PREVIOUS FIX')}\n\n"
        "Please produce a corrected fix. Respond with ONLY a JSON object with keys "
        "\"function_name\" and \"new_code\"."
    )
    return messages + [
        {"role": "assistant", "content": json.dumps({"function_name": "...", "new_code": previous_new_code})},
        {"role": "user",      "content": retry_msg},
    ]


# ---------------------------------------------------------------------------
# LLM response parser
# ---------------------------------------------------------------------------

def _parse_llm_response(text: str) -> Dict[str, str]:
    """
    Extract function_name + new_code from the LLM response.
    Strips markdown fences if the model wrapped JSON in them.
    Raises ValueError on parse failure.
    """
    stripped = text.strip()
    # Strip ```json ... ``` or ``` ... ```
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        inner = "\n".join(lines[1:] if len(lines) > 1 else lines)
        if inner.endswith("```"):
            inner = inner[: inner.rfind("```")]
        stripped = inner.strip()

    try:
        data = json.loads(stripped)
    except Exception:
        # Fallback: extract substring between first { and last }
        if "{" in stripped and "}" in stripped:
            start = stripped.find("{")
            end = stripped.rfind("}") + 1
            data = json.loads(stripped[start:end])
        else:
            raise

    if "function_name" not in data or "new_code" not in data:
        raise ValueError(f"LLM response missing required keys: {data!r}")
    return data


# ---------------------------------------------------------------------------
# Sandbox caller (API / Queue ONLY — no direct-Docker fallback)
# ---------------------------------------------------------------------------

def _call_sandbox(
    working_content: str,
    language: str,
    file_path: str,
    test_command: Optional[List[str]],
    room_id: str,
    extra_files: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Submit snapshot job ({files, command, language}) through the API/queue
    to the hardened worker and wait for the result.
    Uses isSnapshot=true to get the same hardened Docker container limits (read-only mount).
    Fails clearly if the API is down or unavailable.
    """
    filename = file_path.split("/")[-1] if "/" in file_path else file_path
    cmd = test_command or default_command(language, filename)
    files_map = {filename: working_content}
    if extra_files:
        files_map.update(extra_files)

    payload = {
        "roomId": room_id or "ai-sandbox",
        "language": language,
        "files": files_map,
        "command": cmd,
    }

    url = SANDBOX_URL
    body = json.dumps(payload).encode("utf-8")
    internal_secret = os.getenv("INTERNAL_API_SECRET", "codesync-internal-ai-secret")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-internal-secret": internal_secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        logger.error("API sandbox call failed (%s): %s", url, exc)
        raise RuntimeError(f"Sandbox API service unavailable or rejected request: {exc}")


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------

def _emit(state: AgentState, step: str, **fields: Any) -> None:
    progress = state.get("progress")
    if progress is not None:
        progress.emit(step, **fields)


def node_context_builder(state: AgentState) -> AgentState:
    """Initialise working state from the snapshot."""
    _emit(state, "context")
    return {
        "working_content": state["base_text"],
        "retry_count": 0,
        "llm_calls": 0,
        "total_cost_usd": 0.0,
        "total_latency_ms": 0.0,
        "llm_responses": [],
        "error_feedback": None,
        "apply_result": None,
        "sandbox_result": None,
        "critic_result": None,
        "final_status": None,
        "diff_patch": None,
        "function_name_out": None,
        "start_line": None,
        "end_line": None,
        "error_message": None,
        "_hard_error": False,
        "_hard_error_msg": None,
        "function_name": "",
        "new_code": "",
    }


def node_generate_fix(state: AgentState) -> AgentState:
    """Call the LLM to get the function replacement."""
    if state.get("_hard_error"):
        return {}

    provider: BaseLLMProvider = state.get("llm_provider") or get_llm_provider()
    retry_count = state.get("retry_count", 0)
    _emit(state, "generating", attempt=retry_count + 1)

    messages = _build_initial_messages(
        prompt=state["prompt"],
        language=state["language"],
        file_path=state.get("file_path", "main.py"),
        file_content=state.get("working_content", state["base_text"]),
    )

    if retry_count > 0 and state.get("error_feedback") and state.get("new_code"):
        messages = _build_retry_messages(
            messages=messages,
            previous_new_code=state["new_code"],
            error_feedback=state["error_feedback"],
            language=state["language"],
            file_path=state.get("file_path", "main.py"),
        )

    try:
        llm_resp: LLMResponse = provider.generate(messages)
    except Exception as exc:
        logger.error("LLM generate failed: %s", exc)
        return {
            "_hard_error": True,
            "_hard_error_msg": f"LLM provider error: {exc}",
        }

    # Track metrics
    llm_responses = list(state.get("llm_responses", []))
    llm_responses.append({
        "attempt": retry_count + 1,
        "model": llm_resp.model,
        "prompt_tokens": llm_resp.prompt_tokens,
        "completion_tokens": llm_resp.completion_tokens,
        "total_tokens": llm_resp.total_tokens,
        "cost_usd": llm_resp.cost_usd,
        "latency_ms": llm_resp.latency_ms,
        "raw_text": llm_resp.text,
    })

    try:
        parsed = _parse_llm_response(llm_resp.text)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("LLM response parse failed (attempt %d): %s", retry_count + 1, exc)
        # Treat parse failure as a sandbox-like failure so we can retry
        return {
            "llm_calls": state.get("llm_calls", 0) + 1,
            "total_cost_usd": state.get("total_cost_usd", 0.0) + llm_resp.cost_usd,
            "total_latency_ms": state.get("total_latency_ms", 0.0) + llm_resp.latency_ms,
            "llm_responses": llm_responses,
            "error_feedback": f"Your previous response was not valid JSON: {exc}. Raw: {llm_resp.text[:200]}",
            # Inject a synthetic critic_result so the router knows to retry
            "critic_result": {"passed": False, "error_feedback": "LLM parse error", "reason": "llm_parse_error"},
            # Keep existing function_name/new_code for retry context
            "function_name": state.get("function_name", ""),
            "new_code": state.get("new_code", ""),
        }

    return {
        "function_name": parsed["function_name"],
        "new_code": parsed["new_code"],
        "llm_calls": state.get("llm_calls", 0) + 1,
        "total_cost_usd": state.get("total_cost_usd", 0.0) + llm_resp.cost_usd,
        "total_latency_ms": state.get("total_latency_ms", 0.0) + llm_resp.latency_ms,
        "llm_responses": llm_responses,
        "error_feedback": None,
        # Clear critic from previous round so routing is correct
        "critic_result": None,
    }


def node_apply_edit(state: AgentState) -> AgentState:
    """Apply the LLM-generated function replacement to the working copy."""
    if state.get("_hard_error"):
        return {}
    # If parse error path left a critic_result already, skip apply
    if state.get("critic_result") and not state["critic_result"].get("passed"):
        return {}

    _emit(state, "applying", attempt=state.get("retry_count", 0) + 1)
    try:
        result: ApplyResult = apply_function_edit(
            file_content=state.get("working_content", state["base_text"]),
            function_name=state["function_name"],
            new_code=state["new_code"],
            file_path=state.get("file_path", "main.py"),
            language=state.get("language", "python"),
        )
        return {
            "working_content": result.patched_content,
            "apply_result": {
                "diff_patch": result.diff_patch,
                "function_name": result.function_name,
                "original_code": result.original_code,
                "new_code": result.new_code,
                "start_line": result.start_line,
                "end_line": result.end_line,
            },
        }
    except ValueError as exc:
        logger.warning("apply_edit failed: %s", exc)
        return {
            "critic_result": {
                "passed": False,
                "error_feedback": f"Could not locate function '{state.get('function_name')}' in source: {exc}",
                "reason": "function_not_found",
            },
            "error_feedback": f"Could not locate function '{state.get('function_name')}' in source: {exc}",
        }


def node_sandbox_test(state: AgentState) -> AgentState:
    """Run the patched file in the hardened sandbox."""
    if state.get("_hard_error"):
        return {}
    # Skip if critic_result already set (parse error or apply error path)
    if state.get("critic_result") is not None:
        return {}

    _emit(state, "testing", attempt=state.get("retry_count", 0) + 1)
    try:
        result = _call_sandbox(
            working_content=state["working_content"],
            language=state.get("language", "python"),
            file_path=state.get("file_path", "main.py"),
            test_command=state.get("test_command"),
            room_id=state.get("room_id", ""),
            extra_files=state.get("extra_files"),
        )
        return {"sandbox_result": result}
    except Exception as exc:
        logger.error("Sandbox call failed: %s", exc)
        return {
            "_hard_error": True,
            "_hard_error_msg": f"Sandbox API unavailable: {exc}",
            "sandbox_result": {
                "status": "failed",
                "exitCode": 1,
                "stdout": "",
                "stderr": f"Sandbox API unavailable: {exc}",
            },
        }


def node_critic(state: AgentState) -> AgentState:
    """Evaluate sandbox result and decide pass/retry."""
    if state.get("_hard_error"):
        return {}
    # If critic_result was already set (parse error / apply error), keep it
    if state.get("critic_result") is not None:
        return {}

    sandbox_result = state.get("sandbox_result") or {}
    has_test = bool(state.get("test_command"))
    evaluation = evaluate_sandbox_result(sandbox_result, has_reproducing_test=has_test)

    return {
        "critic_result": evaluation,
        "error_feedback": evaluation.get("error_feedback"),
    }


# ---------------------------------------------------------------------------
# Edge routing
# ---------------------------------------------------------------------------

def should_retry_or_finish(state: AgentState) -> Literal["retry", "finish"]:
    """After critic: retry if failed and retries remaining, else finish."""
    if state.get("_hard_error"):
        return "finish"

    critic = state.get("critic_result") or {}
    if critic.get("passed"):
        return "finish"

    retry_count = state.get("retry_count", 0)
    if retry_count < MAX_RETRIES:
        return "retry"

    return "finish"


def node_retry(state: AgentState) -> AgentState:
    """Increment retry counter and reset working content for next attempt."""
    critic = state.get("critic_result") or {}
    _emit(
        state,
        "retrying",
        retry=state.get("retry_count", 0) + 1,
        attempt=state.get("retry_count", 0) + 2,
        reason=critic.get("reason"),
        message=(state.get("error_feedback") or critic.get("error_feedback") or "")[:300] or None,
    )
    return {
        "retry_count": state.get("retry_count", 0) + 1,
        # Reset working_content to base for clean re-apply
        "working_content": state["base_text"],
        # Clear apply/sandbox results for the new round
        "apply_result": None,
        "sandbox_result": None,
        "critic_result": None,
    }


def node_finish(state: AgentState) -> AgentState:
    """Assemble the final output."""
    if state.get("_hard_error"):
        return {
            "final_status": "error",
            "error_message": state.get("_hard_error_msg") or "Unrecoverable agent error",
        }

    critic = state.get("critic_result") or {}
    apply_res = state.get("apply_result") or {}
    retry_count = state.get("retry_count", 0)

    if critic.get("passed"):
        has_test = bool(state.get("test_command"))
        return {
            "final_status": "verified" if has_test else "unverified_no_test",
            "diff_patch": apply_res.get("diff_patch"),
            "function_name_out": apply_res.get("function_name"),
            "start_line": apply_res.get("start_line"),
            "end_line": apply_res.get("end_line"),
        }

    # Determine failure kind
    reason = critic.get("reason", "")
    if reason == "function_not_found" and retry_count >= MAX_RETRIES:
        status = "apply_error"
    elif reason == "function_not_found":
        status = "apply_error"
    else:
        status = "exhausted"

    return {
        "final_status": status,
        "diff_patch": apply_res.get("diff_patch"),
        "function_name_out": apply_res.get("function_name"),
        "start_line": apply_res.get("start_line"),
        "end_line": apply_res.get("end_line"),
        "error_message": state.get("error_feedback") or critic.get("error_feedback") or "All retry attempts failed",
    }


# ---------------------------------------------------------------------------
# Build the graph
# ---------------------------------------------------------------------------

def build_graph():
    """Construct and compile the LangGraph agent."""
    g = StateGraph(AgentState)

    g.add_node("context_builder", node_context_builder)
    g.add_node("generate_fix",   node_generate_fix)
    g.add_node("apply_edit",     node_apply_edit)
    g.add_node("sandbox_test",   node_sandbox_test)
    g.add_node("critic",         node_critic)
    g.add_node("retry",          node_retry)
    g.add_node("finish",         node_finish)

    g.set_entry_point("context_builder")
    g.add_edge("context_builder", "generate_fix")
    g.add_edge("generate_fix",    "apply_edit")
    g.add_edge("apply_edit",      "sandbox_test")
    g.add_edge("sandbox_test",    "critic")

    g.add_conditional_edges(
        "critic",
        should_retry_or_finish,
        {
            "retry": "retry",
            "finish": "finish",
        },
    )
    g.add_edge("retry",  "generate_fix")
    g.add_edge("finish", END)

    return g.compile()


# Singleton graph (compiled once at import time)
_graph = None


def get_graph():
    global _graph
    if _graph is None:
        _graph = build_graph()
    return _graph


# ---------------------------------------------------------------------------
# Convenience runner
# ---------------------------------------------------------------------------

def run_agent(
    room_id: str,
    prompt: str,
    base_text: str,
    base_version: str,
    language: str = "python",
    file_path: str = "main.py",
    test_command: Optional[List[str]] = None,
    llm_provider=None,
    extra_files: Optional[Dict[str, str]] = None,
    progress_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Entry point called by the /fix route.

    Returns a dict with:
      status:          "verified" | "exhausted" | "apply_error" | "error"
      diff_patch:      unified diff string (or None)
      function_name:   replaced function name (or None)
      start_line:      start line in original file (or None)
      end_line:        end line in original file (or None)
      error_message:   human-readable failure reason (or None)
      llm_calls:       total LLM calls made
      total_cost_usd:  estimated cost
      llm_responses:   audit trail
      patched_text:    the full patched file content (for the /accept endpoint)
    """
    # Make a fresh copy of base_text to guarantee we never mutate the caller's string
    base_text_copy = str(base_text)
    progress = ProgressPublisher(progress_id)

    initial_state: AgentState = {
        "room_id": room_id,
        "prompt": prompt,
        "language": language,
        "file_path": file_path,
        "base_text": base_text_copy,
        "base_version": base_version,
        "test_command": test_command or [],
        "extra_files": extra_files or {},
        "llm_provider": llm_provider,
        "progress": progress,
        # Will be initialised by context_builder node
        "working_content": base_text_copy,
        "retry_count": 0,
        "llm_calls": 0,
        "total_cost_usd": 0.0,
        "total_latency_ms": 0.0,
        "llm_responses": [],
        "error_feedback": None,
        "apply_result": None,
        "sandbox_result": None,
        "critic_result": None,
        "final_status": None,
        "diff_patch": None,
        "function_name_out": None,
        "start_line": None,
        "end_line": None,
        "error_message": None,
        "_hard_error": False,
        "_hard_error_msg": None,
        "function_name": "",
        "new_code": "",
    }

    graph = get_graph()
    try:
        final_state = graph.invoke(initial_state)
    except Exception as exc:
        progress.emit("failed", status="error", message=f"Agent error: {exc}"[:300])
        raise

    final_status = final_state.get("final_status") or "error"
    progress.emit(
        "done" if final_status in ("verified", "unverified_no_test") else "failed",
        status=final_status,
        llm_calls=final_state.get("llm_calls", 0),
        total_cost_usd=final_state.get("total_cost_usd", 0.0),
        message=(final_state.get("error_message") or "")[:300] or None,
    )

    return {
        "status": final_state.get("final_status") or "error",
        "diff_patch": final_state.get("diff_patch"),
        "function_name": final_state.get("function_name_out"),
        "start_line": final_state.get("start_line"),
        "end_line": final_state.get("end_line"),
        "error_message": final_state.get("error_message"),
        "llm_calls": final_state.get("llm_calls", 0),
        "total_cost_usd": final_state.get("total_cost_usd", 0.0),
        "total_latency_ms": final_state.get("total_latency_ms", 0.0),
        "llm_responses": final_state.get("llm_responses", []),
        # patched_text: the working_content after the final successful apply
        "patched_text": final_state.get("working_content"),
        "original_code": (final_state.get("apply_result") or {}).get("original_code"),
        "new_code": (final_state.get("apply_result") or {}).get("new_code"),
        "retry_count": final_state.get("retry_count", 0),
    }
