"""
Hybrid code search: combines vector similarity search and keyword matching
over function names using Reciprocal Rank Fusion (RRF, k=60).
See design doc section 4.3.
"""

import logging
from typing import List, Dict, Any, Optional

from app.rag.embedder import get_embedder, BaseEmbedder
from app.rag.qdrant_store import get_qdrant_store, QdrantStore

logger = logging.getLogger(__name__)

RRF_K = 60


def hybrid_search(
    room_id: str,
    query: str,
    limit: int = 10,
    store: Optional[QdrantStore] = None,
    embedder: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    """
    Perform hybrid search in room_id:
    1. Room-filtered vector search using embedding of query.
    2. Room-filtered keyword search on function_name.
    3. Merge rankings using Reciprocal Rank Fusion (k=60).
    """
    if not room_id or not room_id.strip():
        raise ValueError("room_id is required and cannot be empty")
    if not query or not query.strip():
        return []

    clean_query = query.strip()
    embedder = embedder or get_embedder()
    store = store or get_qdrant_store()

    # 1. Vector Search
    query_vector = embedder.embed([clean_query])[0]
    vector_results = store.search_vectors(room_id=room_id, query_vector=query_vector, limit=limit * 2)

    # 2. Keyword Search on function_name
    keyword_results = store.search_keywords(room_id=room_id, query=clean_query, limit=limit * 2)

    # 3. Reciprocal Rank Fusion (k=60)
    # Map by unique identifier (room_id:file_id:content_hash)
    merged_items: Dict[str, Dict[str, Any]] = {}
    rrf_scores: Dict[str, float] = {}

    # Rank 1-indexed in vector results
    for rank, item in enumerate(vector_results, start=1):
        key = f"{item['file_id']}:{item['content_hash']}"
        merged_items[key] = item
        score = 1.0 / (RRF_K + rank)
        rrf_scores[key] = rrf_scores.get(key, 0.0) + score

    # Rank 1-indexed in keyword results
    for rank, item in enumerate(keyword_results, start=1):
        key = f"{item['file_id']}:{item['content_hash']}"
        if key not in merged_items:
            merged_items[key] = item
        score = 1.0 / (RRF_K + rank)
        rrf_scores[key] = rrf_scores.get(key, 0.0) + score

    # Sort merged results by RRF score descending
    sorted_keys = sorted(rrf_scores.keys(), key=lambda k: rrf_scores[k], reverse=True)

    final_results: List[Dict[str, Any]] = []
    for key in sorted_keys[:limit]:
        item = merged_items[key]
        final_results.append({
            "path": item.get("path"),
            "start_line": item.get("start_line"),
            "end_line": item.get("end_line"),
            "ast_type": item.get("ast_type"),
            "function_name": item.get("function_name"),
            "score": round(rrf_scores[key], 6),
            "text": item.get("text"),
            "content_hash": item.get("content_hash"),
        })

    logger.info(
        f"Hybrid search for '{clean_query}' in room '{room_id}': "
        f"{len(vector_results)} vector hits, {len(keyword_results)} keyword hits -> {len(final_results)} merged results"
    )

    return final_results
