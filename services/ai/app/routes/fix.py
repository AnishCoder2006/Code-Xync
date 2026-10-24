from fastapi import APIRouter
from pydantic import BaseModel
import time

router = APIRouter()

class FixRequest(BaseModel):
    room_id: str
    user_id: str
    prompt: str
    code: str
    language: str

class FixResponse(BaseModel):
    patch: str
    status: str

# Mock LLM provider interface for Phase 2
def generate_fix(prompt: str, code: str) -> str:
    """
    Mock function to validate the full loop (API -> AI service -> diff -> Accept -> Yjs merge).
    Swap this mock for a real OpenAI/Anthropic call in Phase 3/4.
    """
    # Simple rule-based mock response
    lines = code.split("\n")
    if lines:
        lines[0] = lines[0] + " // Fixed by AI (mock)"
    return "\n".join(lines)

@router.post("/fix", response_model=FixResponse)
def fix_code(req: FixRequest):
    # Log the incoming request details...
    start = time.time()
    patch = generate_fix(req.prompt, req.code)
    # The real service would index / retrieve from Qdrant, run a critic loop, etc.
    return FixResponse(patch=patch, status="verified")
