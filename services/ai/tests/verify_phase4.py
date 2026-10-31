"""
Comprehensive Phase 4 Proof & Benchmark Suite.
Tests:
1. Cross-room leakage: Room A search never returns Room B content (even for exact same function name).
2. Exact identifier ranking: "parseConfig" query ranks matching function first.
3. Embedding cache: 0 re-embeds for unchanged file, exactly 1 for one edited function.
4. File deletion: deleting a file removes all its points from Qdrant.
5. Latency benchmark: p50/p95 latency report for 100 searches on >= 500 chunks.
"""

import os
import sys
import time
import math
import logging
from typing import List

# Ensure services/ai is on sys.path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AI_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

from app.rag.chunker import chunk_file, CodeChunk
from app.rag.embedder import CachedEmbedder, FastEmbedEmbedder, get_embedder
from app.rag.qdrant_store import QdrantStore
from app.rag.search import hybrid_search

logging.basicConfig(level=logging.ERROR)


def run_all_proofs():
    print("=========================================================================")
    print("               CodeSync Phase 4: Code Search Verification                ")
    print("=========================================================================\n")

    store = QdrantStore(collection_name="codesync_code_chunks", vector_size=384)
    embedder = get_embedder()

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 1: Cross-room leakage prevention
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 1] Verifying Cross-Room Leakage Prevention...")
    room_a = "proof-room-alpha"
    room_b = "proof-room-beta"

    code_a = """
def parseConfig(env: str):
    '''Room Alpha config parser'''
    return {"room": "alpha", "secret": "alpha-secret-key-12345"}
"""
    code_b = """
def parseConfig(env: str):
    '''Room Beta config parser'''
    return {"room": "beta", "secret": "beta-secret-key-67890"}
"""

    chunks_a = chunk_file("config.py", code_a, "python")
    chunks_b = chunk_file("config.py", code_b, "python")

    vecs_a = embedder.embed_chunks(chunks_a)
    vecs_b = embedder.embed_chunks(chunks_b)

    store.upsert_chunks(room_a, "file-alpha-1", "config.py", chunks_a, vecs_a)
    store.upsert_chunks(room_b, "file-beta-1", "config.py", chunks_b, vecs_b)

    # Search in Room A
    results_a = hybrid_search(room_a, "parseConfig", limit=10)
    # Search in Room B
    results_b = hybrid_search(room_b, "parseConfig", limit=10)

    print(f"Room A search hits: {len(results_a)}, top text: {results_a[0]['text'].strip()[:40]}...")
    print(f"Room B search hits: {len(results_b)}, top text: {results_b[0]['text'].strip()[:40]}...")

    # Strict assertions
    for r in results_a:
        assert "beta" not in r["text"], "LEAK DETECTED: Room B content found in Room A search!"
        assert "alpha" in r["text"]
    for r in results_b:
        assert "alpha" not in r["text"], "LEAK DETECTED: Room A content found in Room B search!"
        assert "beta" in r["text"]

    print(" PASS: Zero cross-room leakage. Room A never returns Room B content.\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 2: Exact identifier ranking ("parseConfig" ranks first)
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 2] Verifying Exact Identifier Query Ranking...")
    room_ident = "proof-room-ident"
    ident_code = """
def initializeEnvironment():
    return True

def loadGeneralSettings():
    return {"theme": "dark"}

def parseConfig():
    '''Exact target function'''
    return {"parsed": True}

def validateConfigurationSyntax():
    return True

def saveConfigToFile():
    pass
"""
    chunks_ident = chunk_file("settings.py", ident_code, "python")
    vecs_ident = embedder.embed_chunks(chunks_ident)
    store.upsert_chunks(room_ident, "file-ident", "settings.py", chunks_ident, vecs_ident)

    search_ident = hybrid_search(room_ident, "parseConfig", limit=5)
    print(f"Top result for 'parseConfig': {search_ident[0]['function_name']} (score: {search_ident[0]['score']})")

    assert search_ident[0]["function_name"] == "parseConfig", \
        f"Expected parseConfig to rank #1, but got {search_ident[0]['function_name']}"
    print(" PASS: Exact identifier query 'parseConfig' ranks matching function first.\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 3: Embedding cache (0 re-embeds on unchanged, 1 on edit)
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 3] Verifying Embedding Cache Hit-Rate & Invalidation...")
    # Clean dedicated embedder instance for exact measurement
    clean_embedder = CachedEmbedder()

    test_file_code = """
def funcOne():
    return 1

def funcTwo():
    return 2

def funcThree():
    return 3
"""
    initial_chunks = chunk_file("test.py", test_file_code, "python")
    assert len(initial_chunks) == 3

    # Step A: Initial index (3 misses, 0 hits)
    clean_embedder.embed_chunks(initial_chunks)
    assert clean_embedder.total_misses == 3
    assert clean_embedder.total_hits == 0

    # Step B: Re-index unchanged file (0 new misses, 3 hits)
    unchanged_chunks = chunk_file("test.py", test_file_code, "python")
    misses_before = clean_embedder.total_misses
    hits_before = clean_embedder.total_hits
    clean_embedder.embed_chunks(unchanged_chunks)

    re_embeds = clean_embedder.total_misses - misses_before
    new_hits = clean_embedder.total_hits - hits_before
    print(f"Re-indexing unchanged file: {re_embeds} new embeds, {new_hits} cache hits")
    assert re_embeds == 0, f"Expected 0 re-embeds for unchanged file, got {re_embeds}"
    assert new_hits == 3

    # Step C: Edit exactly one function (funcTwo)
    edited_file_code = """
def funcOne():
    return 1

def funcTwo():
    # Modified body
    return 200

def funcThree():
    return 3
"""
    edited_chunks = chunk_file("test.py", edited_file_code, "python")
    misses_before_edit = clean_embedder.total_misses
    clean_embedder.embed_chunks(edited_chunks)

    edited_re_embeds = clean_embedder.total_misses - misses_before_edit
    print(f"Re-indexing after editing 1 function: exactly {edited_re_embeds} re-embed")
    assert edited_re_embeds == 1, f"Expected exactly 1 re-embed, got {edited_re_embeds}"
    print(" PASS: Unchanged file = 0 re-embeds, 1 edited function = 1 re-embed.\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 4: File deletion removes points
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 4] Verifying File Deletion Removes Points...")
    del_room = "proof-room-deletion"
    del_file = "file-to-delete"
    del_chunks = chunk_file("temporary.py", "def tempFunc(): pass\ndef anotherTemp(): pass", "python")
    del_vecs = embedder.embed_chunks(del_chunks)
    store.upsert_chunks(del_room, del_file, "temporary.py", del_chunks, del_vecs)

    before_count = len(store.search_vectors(del_room, del_vecs[0], limit=10))
    assert before_count > 0, "Points should exist before deletion"

    store.delete_file(del_file)
    after_count = len(store.search_vectors(del_room, del_vecs[0], limit=10))
    print(f"Points before delete: {before_count}, points after delete: {after_count}")
    assert after_count == 0, f"Expected 0 points after delete, got {after_count}"
    print(" PASS: delete_file successfully purged points from Qdrant.\n")

    # ─────────────────────────────────────────────────────────────────────────
    # Proof 5: Latency report (p50/p95 for 100 searches on >= 500 chunks)
    # ─────────────────────────────────────────────────────────────────────────
    print("[Proof 5] Generating Search Latency Report (>= 500 chunks, 100 queries)...")
    latency_room = "benchmark-latency-room"
    total_target_chunks = 520

    print(f"Seeding {total_target_chunks} code chunks into room '{latency_room}'...")
    all_seeded_chunks: List[CodeChunk] = []

    # Generate 52 files with 10 functions each = 520 chunks
    for file_idx in range(52):
        funcs = []
        for fn_idx in range(10):
            funcs.append(f"""
def module_{file_idx}_handler_{fn_idx}(request: dict, options: list):
    '''Handler function {fn_idx} for data processing in module {file_idx}'''
    val = request.get('key_{fn_idx}', {fn_idx})
    return val * {file_idx + 1}
""")
        file_content = "\n".join(funcs)
        file_path = f"src/modules/module_{file_idx}.py"
        file_chunks = chunk_file(file_path, file_content, "python")
        all_seeded_chunks.extend(file_chunks)

    print(f"Total chunks generated: {len(all_seeded_chunks)}")
    seeded_embeddings = []
    chunk_batch_size = 50
    for i in range(0, len(all_seeded_chunks), chunk_batch_size):
        batch = all_seeded_chunks[i : i + chunk_batch_size]
        seeded_embeddings.extend(embedder.embed_chunks(batch))
    store.upsert_chunks(latency_room, "batch-latency-file", "batch.py", all_seeded_chunks, seeded_embeddings)

    total_in_room = store.count_chunks(latency_room)
    print(f"Verified chunks in Qdrant room index: {total_in_room} (>= 500 requirement met)")
    assert total_in_room >= 500, f"Expected at least 500 chunks, got {total_in_room}"

    # Benchmark queries
    queries = [
        "module handler data processing",
        "calculate total request value",
        "module_10_handler_5",
        "options list processing",
        "request key multiplier",
        "module_42_handler_9",
        "data handler return val",
        "parse environment options",
        "module_25_handler_0",
        "request handler val calculation",
    ]

    latencies_ms: List[float] = []
    print("Executing 100 hybrid searches...")
    for i in range(100):
        q = queries[i % len(queries)]
        t0 = time.perf_counter()
        _ = hybrid_search(latency_room, q, limit=10)
        t1 = time.perf_counter()
        latencies_ms.append((t1 - t0) * 1000.0)

    latencies_ms.sort()
    p50 = latencies_ms[int(len(latencies_ms) * 0.50)]
    p95 = latencies_ms[int(len(latencies_ms) * 0.95)]
    p99 = latencies_ms[int(len(latencies_ms) * 0.99)]
    avg = sum(latencies_ms) / len(latencies_ms)
    min_lat = latencies_ms[0]
    max_lat = latencies_ms[-1]

    print("\n=========================================================================")
    print("                    SEARCH LATENCY BENCHMARK REPORT                      ")
    print("=========================================================================")
    print(f"Index Size:       {total_in_room} chunks in room collection")
    print(f"Search Queries:   100 hybrid searches (vector + keyword RRF k=60)")
    print(f"Embedding Model:  fastembed (BAAI/bge-small-en-v1.5, 384 dim, ONNX)")
    print("-------------------------------------------------------------------------")
    print(f"Minimum Latency:  {min_lat:.2f} ms")
    print(f"Average Latency:  {avg:.2f} ms")
    print(f"p50 Latency:      {p50:.2f} ms")
    print(f"p95 Latency:      {p95:.2f} ms")
    print(f"p99 Latency:      {p99:.2f} ms")
    print(f"Maximum Latency:  {max_lat:.2f} ms")
    print("=========================================================================\n")

    # Cleanup latency test room
    store.delete_room(latency_room)
    store.delete_room(room_a)
    store.delete_room(room_b)
    store.delete_room(room_ident)
    store.delete_room(del_room)

    print("All Phase 4 proofs PASSED successfully!")


if __name__ == "__main__":
    run_all_proofs()
