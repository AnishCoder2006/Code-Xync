"""
Qdrant vector store integration for CodeSync Code Search.
Payload per design doc 4.2:
- room_id (keyword, indexed)
- file_id (keyword, indexed)
- path (keyword)
- content_hash (keyword, indexed)
- ast_type (keyword)
- language (keyword)
- function_name (text, indexed)
- start_line (integer)
- end_line (integer)
- text (string)

Strictly enforces room_id filtering on every query to guarantee zero cross-room leakage.
"""

import os
import uuid
import logging
from typing import List, Dict, Any, Optional
from qdrant_client import QdrantClient, models
from qdrant_client.http.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue, MatchText

from app.rag.chunker import CodeChunk

logger = logging.getLogger(__name__)

DEFAULT_COLLECTION = "codesync_code_chunks"
DEFAULT_VECTOR_SIZE = 384


class QdrantStore:
    def __init__(self, url: Optional[str] = None, collection_name: str = DEFAULT_COLLECTION, vector_size: int = DEFAULT_VECTOR_SIZE):
        self.url = url or os.getenv("QDRANT_URL", "http://localhost:6333")
        self.collection_name = collection_name
        self.vector_size = vector_size
        self.client = QdrantClient(url=self.url)
        self.init_collection()

    def init_collection(self):
        """Create collection and create payload indexes if they do not exist."""
        try:
            collections = self.client.get_collections().collections
            exists = any(c.name == self.collection_name for c in collections)

            if not exists:
                logger.info(f"Creating Qdrant collection '{self.collection_name}' with dim {self.vector_size}")
                self.client.create_collection(
                    collection_name=self.collection_name,
                    vectors_config=VectorParams(size=self.vector_size, distance=Distance.COSINE),
                )

            # Ensure payload indexes exist
            self._create_payload_indexes()
        except Exception as e:
            logger.error(f"Error initializing Qdrant collection: {e}")
            raise

    def _create_payload_indexes(self):
        """Create required payload indexes for room_id, file_id, content_hash, and function_name."""
        try:
            # Keyword indexes
            for field in ("room_id", "file_id", "content_hash"):
                try:
                    self.client.create_payload_index(
                        collection_name=self.collection_name,
                        field_name=field,
                        field_schema=models.PayloadSchemaType.KEYWORD,
                    )
                except Exception:
                    pass

            # Text index on function_name
            try:
                self.client.create_payload_index(
                    collection_name=self.collection_name,
                    field_name="function_name",
                    field_schema=models.TextIndexParams(
                        type="text",
                        tokenizer=models.TokenizerType.WORD,
                        lowercase=True,
                    ),
                )
            except Exception:
                pass
        except Exception as e:
            logger.warning(f"Error creating payload indexes: {e}")

    def upsert_chunks(
        self,
        room_id: str,
        file_id: str,
        path: str,
        chunks: List[CodeChunk],
        embeddings: List[List[float]],
    ):
        """
        Upsert chunks for a file into Qdrant.
        Deletes points for that file_id whose content_hash is no longer present.
        Upserts new/changed ones.
        """
        if not room_id or not room_id.strip():
            raise ValueError("room_id is required and cannot be empty")
        if not file_id or not file_id.strip():
            raise ValueError("file_id is required and cannot be empty")

        current_hashes = {chunk.content_hash for chunk in chunks}

        # 1. Fetch existing points for this file to identify removed chunks
        existing_points, _ = self.client.scroll(
            collection_name=self.collection_name,
            scroll_filter=Filter(
                must=[
                    FieldCondition(key="room_id", match=MatchValue(value=room_id)),
                    FieldCondition(key="file_id", match=MatchValue(value=file_id)),
                ]
            ),
            limit=1000,
            with_payload=True,
            with_vectors=False,
        )

        obsolete_point_ids = []
        existing_hashes = set()
        for pt in existing_points:
            pt_payload = pt.payload or {}
            pt_hash = pt_payload.get("content_hash")
            existing_hashes.add(pt_hash)
            if pt_hash not in current_hashes:
                obsolete_point_ids.append(pt.id)

        # 2. Delete obsolete points
        if obsolete_point_ids:
            logger.info(f"Deleting {len(obsolete_point_ids)} obsolete chunks for file {file_id}")
            self.client.delete(
                collection_name=self.collection_name,
                points_selector=models.PointIdsList(points=obsolete_point_ids),
            )

        # 3. Prepare points to upsert
        points_to_upsert: List[PointStruct] = []
        for chunk, vector in zip(chunks, embeddings):
            # Deterministic UUIDv5 for point ID based on (room_id, file_id, content_hash)
            point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{room_id}:{file_id}:{chunk.content_hash}"))

            payload = {
                "room_id": room_id,
                "file_id": file_id,
                "path": path,
                "ast_type": chunk.ast_type,
                "language": chunk.language,
                "function_name": chunk.function_name,
                "start_line": chunk.start_line,
                "end_line": chunk.end_line,
                "content_hash": chunk.content_hash,
                "text": chunk.text,
            }

            points_to_upsert.append(PointStruct(id=point_id, vector=vector, payload=payload))

        if points_to_upsert:
            logger.info(f"Upserting {len(points_to_upsert)} chunks to Qdrant for room {room_id}, file {file_id}")
            self.client.upsert(collection_name=self.collection_name, points=points_to_upsert)

    def delete_file(self, file_id: str):
        """Delete all points associated with a file_id."""
        if not file_id or not file_id.strip():
            raise ValueError("file_id is required and cannot be empty")

        self.client.delete(
            collection_name=self.collection_name,
            points_selector=models.FilterSelector(
                filter=Filter(must=[FieldCondition(key="file_id", match=MatchValue(value=file_id))])
            ),
        )
        logger.info(f"Deleted points for file_id {file_id}")

    def delete_room(self, room_id: str):
        """Delete all points associated with a room_id."""
        if not room_id or not room_id.strip():
            raise ValueError("room_id is required and cannot be empty")

        self.client.delete(
            collection_name=self.collection_name,
            points_selector=models.FilterSelector(
                filter=Filter(must=[FieldCondition(key="room_id", match=MatchValue(value=room_id))])
            ),
        )
        logger.info(f"Deleted points for room_id {room_id}")

    def search_vectors(self, room_id: str, query_vector: List[float], limit: int = 10) -> List[Dict[str, Any]]:
        """
        Vector similarity search strictly filtered by room_id.
        Raises ValueError if room_id is missing or empty.
        """
        if not room_id or not str(room_id).strip():
            raise ValueError("room_id is required and cannot be empty for vector search")

        if hasattr(self.client, "query_points"):
            response = self.client.query_points(
                collection_name=self.collection_name,
                query=query_vector,
                query_filter=Filter(
                    must=[FieldCondition(key="room_id", match=MatchValue(value=room_id))]
                ),
                limit=limit,
                with_payload=True,
            )
            results = response.points
        else:
            results = getattr(self.client, "search")(
                collection_name=self.collection_name,
                query_vector=query_vector,
                query_filter=Filter(
                    must=[FieldCondition(key="room_id", match=MatchValue(value=room_id))]
                ),
                limit=limit,
                with_payload=True,
            )

        output = []
        for r in results:
            payload = r.payload or {}
            output.append({
                "id": str(r.id),
                "score": r.score,
                "room_id": payload.get("room_id"),
                "file_id": payload.get("file_id"),
                "path": payload.get("path"),
                "ast_type": payload.get("ast_type"),
                "language": payload.get("language"),
                "function_name": payload.get("function_name"),
                "start_line": payload.get("start_line"),
                "end_line": payload.get("end_line"),
                "content_hash": payload.get("content_hash"),
                "text": payload.get("text"),
            })
        return output

    def search_keywords(self, room_id: str, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Exact and token-level keyword search on function_name strictly filtered by room_id.
        Raises ValueError if room_id is missing or empty.
        """
        if not room_id or not str(room_id).strip():
            raise ValueError("room_id is required and cannot be empty for keyword search")

        clean_query = query.strip()
        if not clean_query:
            return []

        # Query function_name using text match
        results, _ = self.client.scroll(
            collection_name=self.collection_name,
            scroll_filter=Filter(
                must=[
                    FieldCondition(key="room_id", match=MatchValue(value=room_id)),
                    FieldCondition(key="function_name", match=MatchText(text=clean_query)),
                ]
            ),
            limit=limit * 2,
            with_payload=True,
            with_vectors=False,
        )

        output = []
        for r in results:
            payload = r.payload or {}
            fn_name = payload.get("function_name", "")
            # Boost exact identifier matches
            score = 1.0 if fn_name.lower() == clean_query.lower() else 0.5
            output.append({
                "id": str(r.id),
                "score": score,
                "room_id": payload.get("room_id"),
                "file_id": payload.get("file_id"),
                "path": payload.get("path"),
                "ast_type": payload.get("ast_type"),
                "language": payload.get("language"),
                "function_name": fn_name,
                "start_line": payload.get("start_line"),
                "end_line": payload.get("end_line"),
                "content_hash": payload.get("content_hash"),
                "text": payload.get("text"),
            })

        # Sort exact matches first
        output.sort(key=lambda x: x["score"], reverse=True)
        return output[:limit]

    def count_chunks(self, room_id: Optional[str] = None) -> int:
        filter_obj = None
        if room_id:
            filter_obj = Filter(must=[FieldCondition(key="room_id", match=MatchValue(value=room_id))])
        res = self.client.count(collection_name=self.collection_name, count_filter=filter_obj)
        return res.count


# Singleton instance helper
_default_store: Optional[QdrantStore] = None


def get_qdrant_store() -> QdrantStore:
    global _default_store
    if _default_store is None:
        _default_store = QdrantStore()
    return _default_store
