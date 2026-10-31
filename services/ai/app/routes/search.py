"""
Search API route: POST /search.
Handles room-filtered hybrid code search queries.
Validated and called exclusively by the API service.
"""

from typing import Optional, List
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.rag.search import hybrid_search

router = APIRouter(tags=["search"])


class SearchRequest(BaseModel):
    roomId: str = Field(..., min_length=1, description="Target room ID (required)")
    query: str = Field(..., min_length=1, description="Search query string (required)")
    limit: Optional[int] = Field(default=10, ge=1, le=100, description="Max results to return")


class SearchResultItem(BaseModel):
    path: str
    start_line: int
    end_line: int
    ast_type: str
    function_name: str
    score: float
    text: str
    content_hash: str


@router.post("/search", response_model=List[SearchResultItem])
def search_code(req: SearchRequest):
    """
    Search code inside a single room using hybrid vector + keyword search.
    Guarantees zero cross-room leakage through mandatory room_id filtering.
    """
    if not req.roomId.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="roomId cannot be empty or whitespace",
        )
    if not req.query.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="query cannot be empty or whitespace",
        )

    try:
        results = hybrid_search(room_id=req.roomId.strip(), query=req.query.strip(), limit=req.limit or 10)
        return results
    except ValueError as ve:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Search failed: {e}")
