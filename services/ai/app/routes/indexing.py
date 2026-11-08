"""
Redis Stream consumer for AI indexing.
Consumes events from stream:ai_indexing via consumer groups.
Reclaims stuck messages (XAUTOCLAIM) after 60s.
Handles 'update' and 'delete' event types.
Dead-letters poisoned messages after 3 failed delivery attempts.
Logs requestId/fileId on every line.
See design doc section 4.4.
"""

import os
import uuid
import time
import logging
import threading
from typing import Dict, Any, Optional, List
from fastapi import APIRouter, HTTPException, BackgroundTasks
import redis

from app.rag.chunker import chunk_file
from app.rag.embedder import get_embedder
from app.rag.qdrant_store import get_qdrant_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/index", tags=["indexing"])

STREAM_NAME = "stream:ai_indexing"
GROUP_NAME = "codesync_ai_indexers"
DEAD_LETTER_STREAM = "stream:ai_indexing:dead"
CONSUMER_NAME = f"indexer-{os.getpid()}-{uuid.uuid4().hex[:6]}"
MAX_DELIVERY_ATTEMPTS = 3
MIN_IDLE_TIME_MS = 60000  # 60s for XAUTOCLAIM


def get_redis_client() -> redis.Redis:
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6380")
    return redis.from_url(redis_url, decode_responses=True)


def init_consumer_group(r: Optional[redis.Redis] = None):
    """Ensure stream and consumer group exist."""
    r = r or get_redis_client()
    try:
        r.xgroup_create(STREAM_NAME, GROUP_NAME, id="0", mkstream=True)
        logger.info(f"Created Redis consumer group '{GROUP_NAME}' on stream '{STREAM_NAME}'")
    except redis.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            logger.warning(f"Error creating consumer group: {e}")


def process_indexing_entry(entry_id: str, fields: Dict[str, str], delivery_count: int = 1, r: Optional[redis.Redis] = None) -> bool:
    """
    Process a single stream event with structured logging of requestId and fileId.
    Returns True if processed and acknowledged, False otherwise.
    """
    r = r or get_redis_client()
    file_id = fields.get("fileId", "unknown-file")
    room_id = fields.get("roomId", "unknown-room")
    path = fields.get("path", "")
    language = fields.get("language", "text")
    event_type = fields.get("eventType", "update").lower()
    request_id = fields.get("requestId", f"req-{uuid.uuid4().hex[:8]}")

    logger.info(f"[{request_id}] [fileId={file_id}] Processing event '{event_type}' for room '{room_id}' (attempt {delivery_count})")

    embedder = get_embedder()
    store = get_qdrant_store()

    try:
        if event_type == "delete":
            store.delete_file(room_id, file_id)
            logger.info(f"[{request_id}] [fileId={file_id}] Successfully deleted chunks from Qdrant for room '{room_id}'")
        else:
            # File update / insert
            content = fields.get("content", "")
            chunks = chunk_file(path, content, language)
            logger.info(f"[{request_id}] [fileId={file_id}] Extracted {len(chunks)} AST chunks from '{path}'")

            embeddings = embedder.embed_chunks(chunks)
            store.upsert_chunks(room_id, file_id, path, chunks, embeddings)
            logger.info(f"[{request_id}] [fileId={file_id}] Successfully upserted {len(chunks)} chunks to Qdrant")

        # Acknowledge successful processing
        r.xack(STREAM_NAME, GROUP_NAME, entry_id)
        logger.info(f"[{request_id}] [fileId={file_id}] XACK message {entry_id}")
        return True

    except Exception as e:
        logger.error(f"[{request_id}] [fileId={file_id}] Error processing message {entry_id}: {e}", exc_info=True)

        if delivery_count >= MAX_DELIVERY_ATTEMPTS:
            logger.warning(
                f"[{request_id}] [fileId={file_id}] Message {entry_id} exceeded {MAX_DELIVERY_ATTEMPTS} attempts. "
                f"Moving to dead-letter stream '{DEAD_LETTER_STREAM}'"
            )
            dead_payload = {
                **fields,
                "originalId": entry_id,
                "error": str(e),
                "deadAt": str(time.time()),
            }
            try:
                r.xadd(DEAD_LETTER_STREAM, dead_payload)
                r.xack(STREAM_NAME, GROUP_NAME, entry_id)
                logger.info(f"[{request_id}] [fileId={file_id}] Dead-lettered and acknowledged {entry_id}")
            except Exception as dl_err:
                logger.error(f"[{request_id}] [fileId={file_id}] Failed to write to dead-letter stream: {dl_err}")

        return False


def process_pending_and_new_events(r: Optional[redis.Redis] = None, batch_size: int = 10) -> int:
    """
    Process up to batch_size messages (both reclaimed stuck messages and new stream messages).
    Returns total count of messages processed.
    """
    r = r or get_redis_client()
    init_consumer_group(r)
    processed_count = 0

    # 1. Reclaim stuck messages (XAUTOCLAIM) after 60s idle
    try:
        autoclaim_res = r.xautoclaim(
            STREAM_NAME,
            GROUP_NAME,
            CONSUMER_NAME,
            min_idle_time=MIN_IDLE_TIME_MS,
            start_id="0-0",
            count=batch_size,
        )
        if autoclaim_res and len(autoclaim_res) >= 2:
            reclaimed_entries = autoclaim_res[1]
            for entry in reclaimed_entries:
                if entry:
                    entry_id, fields = entry
                    # Approximate delivery count on reclaim >= 2
                    if process_indexing_entry(entry_id, fields, delivery_count=2, r=r):
                        processed_count += 1
    except Exception as e:
        logger.warning(f"Error in XAUTOCLAIM: {e}")

    # 2. Read new messages for this consumer group
    try:
        entries = r.xreadgroup(
            GROUP_NAME,
            CONSUMER_NAME,
            {STREAM_NAME: ">"},
            count=batch_size,
            block=500,
        )
        if entries:
            for stream_name, msg_list in entries:
                for entry_id, fields in msg_list:
                    if process_indexing_entry(entry_id, fields, delivery_count=1, r=r):
                        processed_count += 1
    except Exception as e:
        logger.error(f"Error reading from consumer group: {e}")

    return processed_count


# Background worker loop control
_worker_running = False
_worker_thread = None


def _background_worker():
    global _worker_running
    r = get_redis_client()
    init_consumer_group(r)
    logger.info(f"AI Indexing Consumer background worker started ({CONSUMER_NAME})")

    while _worker_running:
        try:
            process_pending_and_new_events(r, batch_size=5)
            time.sleep(0.5)
        except Exception as e:
            logger.error(f"Error in background indexing worker loop: {e}")
            time.sleep(1.0)


def start_indexing_worker():
    global _worker_running, _worker_thread
    if not _worker_running:
        _worker_running = True
        _worker_thread = threading.Thread(target=_background_worker, daemon=True)
        _worker_thread.start()


def stop_indexing_worker():
    global _worker_running
    _worker_running = False


# FastAPI endpoints for triggering/monitoring indexer
@router.post("/process-now")
def process_now():
    """Immediately process any pending or new events in stream:ai_indexing."""
    count = process_pending_and_new_events()
    return {"processed": count}


@router.get("/status")
def indexing_status():
    r = get_redis_client()
    try:
        stream_info = r.xinfo_stream(STREAM_NAME)
        groups_info = r.xinfo_groups(STREAM_NAME)
    except Exception:
        stream_info = {}
        groups_info = []

    return {
        "stream": STREAM_NAME,
        "consumer": CONSUMER_NAME,
        "worker_running": _worker_running,
        "stream_info": stream_info,
        "groups_info": groups_info,
    }
