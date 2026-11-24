"""
POST /fix — Verified AI fix loop (Phase 5).
Replaces the Phase 2 mock with the real LangGraph agent.

The browser calls the API service only; never the AI service directly.
The live Yjs document is NEVER touched here — only a human Accept can do that.
"""

import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional

from app.agent.graph import run_agent

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class FixRequest(BaseModel):
    room_id: str
    user_id: str
    prompt: str
    code: str                              # full file text snapshot
    language: str = "python"
    file_path: str = "main.py"
    base_version: str = "latest"           # Yjs state vector (base64); "latest" = Phase 2 compat
    test_command: List[str] = Field(default_factory=list)  # e.g. ["pytest", "tests/test_foo.py"]
    extra_files: Optional[dict] = Field(default_factory=dict)  # extra files mounted alongside target file
    progress_id: Optional[str] = None      # UUID; steps are published to Redis ai:progress:<id> (SSE via API)


class FixResponse(BaseModel):
    # Core output
    patch: str                             # unified diff (empty string if failed)
    status: str                            # "verified" | "exhausted" | "apply_error" | "error"
    function_name: Optional[str] = None
    start_line: Optional[int] = None
    end_line: Optional[int] = None

    # For human-review UI & targeted range apply
    patched_text: Optional[str] = None    # full patched file text (so UI can render Monaco diff)
    original_code: Optional[str] = None   # replaced function code
    new_code: Optional[str] = None        # new replacement function code
    error_message: Optional[str] = None

    # Telemetry
    llm_calls: int = 0
    total_cost_usd: float = 0.0


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post("/fix", response_model=FixResponse)
def fix_code(req: FixRequest) -> FixResponse:
    """
    Run the LangGraph verified fix loop on a copy of the file.
    Returns the diff and patched text for human review.
    The live Yjs document is NOT modified here.
    """
    logger.info(
        "fix request: room=%s user=%s language=%s base_version=%s",
        req.room_id, req.user_id, req.language, req.base_version,
    )

    try:
        result = run_agent(
            room_id=req.room_id,
            prompt=req.prompt,
            base_text=req.code,
            base_version=req.base_version,
            language=req.language,
            file_path=req.file_path,
            test_command=req.test_command,
            extra_files=req.extra_files,
            progress_id=req.progress_id,
        )
    except Exception as exc:
        logger.exception("run_agent raised unexpectedly: %s", exc)
        raise HTTPException(status_code=500, detail=f"Agent error: {exc}")

    status = result.get("status", "error")
    logger.info(
        "fix result: room=%s status=%s llm_calls=%d cost=$%.6f",
        req.room_id, status, result.get("llm_calls", 0), result.get("total_cost_usd", 0.0),
    )

    return FixResponse(
        patch=result.get("diff_patch") or "",
        status=status,
        function_name=result.get("function_name"),
        start_line=result.get("start_line"),
        end_line=result.get("end_line"),
        patched_text=result.get("patched_text"),
        original_code=result.get("original_code"),
        new_code=result.get("new_code"),
        error_message=result.get("error_message"),
        llm_calls=result.get("llm_calls", 0),
        total_cost_usd=result.get("total_cost_usd", 0.0),
    )
