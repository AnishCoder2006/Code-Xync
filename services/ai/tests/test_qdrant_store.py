"""
Unit tests for app.rag.qdrant_store:
- room_id required check (raise if empty)
- cross-room isolation (Room A query never returns Room B)
- delete_file removes points
"""

import pytest
from app.rag.chunker import CodeChunk
from app.rag.embedder import DummyEmbedder
from app.rag.qdrant_store import QdrantStore

embedder = DummyEmbedder(dimension=384)


@pytest.fixture
def store():
    # Use dedicated test collection
    test_collection = "test_codesync_chunks"
    s = QdrantStore(collection_name=test_collection, vector_size=384)
    yield s
    try:
        s.client.delete_collection(test_collection)
    except Exception:
        pass


def test_room_id_required(store):
    with pytest.raises(ValueError, match="room_id is required"):
        store.search_vectors("", [0.0] * 384)

    with pytest.raises(ValueError, match="room_id is required"):
        store.search_vectors(None, [0.0] * 384)

    with pytest.raises(ValueError, match="room_id is required"):
        store.search_keywords("", "parseConfig")


def test_cross_room_isolation_and_delete(store):
    room_a = "room-alpha"
    room_b = "room-beta"

    chunk_a = CodeChunk(
        text="def parseConfig(): return 'alpha'",
        ast_type="function",
        function_name="parseConfig",
        language="python",
        start_line=1,
        end_line=2,
        content_hash="hash_a",
    )
    chunk_b = CodeChunk(
        text="def parseConfig(): return 'beta'",
        ast_type="function",
        function_name="parseConfig",
        language="python",
        start_line=1,
        end_line=2,
        content_hash="hash_b",
    )

    vec_a = embedder.embed([chunk_a.text])
    vec_b = embedder.embed([chunk_b.text])

    store.upsert_chunks(room_a, "file-1", "config.py", [chunk_a], vec_a)
    store.upsert_chunks(room_b, "file-2", "config.py", [chunk_b], vec_b)

    # Search in Room A: must return Room A only, NEVER Room B
    res_a = store.search_vectors(room_a, vec_a[0], limit=10)
    assert len(res_a) == 1
    assert res_a[0]["room_id"] == room_a
    assert "alpha" in res_a[0]["text"]

    # Keyword search in Room A: must return Room A only
    kw_a = store.search_keywords(room_a, "parseConfig", limit=10)
    assert len(kw_a) == 1
    assert kw_a[0]["room_id"] == room_a
    assert "alpha" in kw_a[0]["text"]

    # Search in Room B: must return Room B only
    res_b = store.search_vectors(room_b, vec_b[0], limit=10)
    assert len(res_b) == 1
    assert res_b[0]["room_id"] == room_b
    assert "beta" in res_b[0]["text"]

    # Delete file in Room A
    store.delete_file(room_a, "file-1")
    assert len(store.search_vectors(room_a, vec_a[0], limit=10)) == 0
    # Room B still intact
    assert len(store.search_vectors(room_b, vec_b[0], limit=10)) == 1


def test_delete_file_shared_file_id_across_rooms(store):
    room_1 = "room-shared-1"
    room_2 = "room-shared-2"
    shared_file_id = "shared-file-xyz"

    chunk_1 = CodeChunk(
        text="def computeMetrics(): return 42",
        ast_type="function",
        function_name="computeMetrics",
        language="python",
        start_line=1,
        end_line=2,
        content_hash="hash_m1",
    )
    chunk_2 = CodeChunk(
        text="def computeMetrics(): return 99",
        ast_type="function",
        function_name="computeMetrics",
        language="python",
        start_line=1,
        end_line=2,
        content_hash="hash_m2",
    )

    vec_1 = embedder.embed([chunk_1.text])
    vec_2 = embedder.embed([chunk_2.text])

    # Both rooms use the EXACT SAME file_id
    store.upsert_chunks(room_1, shared_file_id, "metrics.py", [chunk_1], vec_1)
    store.upsert_chunks(room_2, shared_file_id, "metrics.py", [chunk_2], vec_2)

    assert len(store.search_vectors(room_1, vec_1[0], limit=10)) == 1
    assert len(store.search_vectors(room_2, vec_2[0], limit=10)) == 1

    # Deleting the file in room_1 must NOT affect room_2
    store.delete_file(room_1, shared_file_id)

    assert len(store.search_vectors(room_1, vec_1[0], limit=10)) == 0
    res_2 = store.search_vectors(room_2, vec_2[0], limit=10)
    assert len(res_2) == 1
    assert res_2[0]["room_id"] == room_2
    assert "99" in res_2[0]["text"]
