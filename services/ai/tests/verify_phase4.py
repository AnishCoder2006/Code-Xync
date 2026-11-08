"""
Comprehensive Phase 4 Proof & Benchmark Suite.
Tests:
1. Cross-room leakage: Room A search never returns Room B content.
2. Exact identifier ranking: "parseConfig" query ranks matching function first.
3. Keyword-only ranking: function name completely unrelated to its body ranks first via keyword boost.
4. Embedding cache: 0 re-embeds for unchanged file, exactly 1 for one edited function.
5. File deletion with shared file_id: two rooms share a file_id, deleting in Room A leaves Room B intact.
6. Cold latency benchmark: 20 rooms x 500 chunks (10,000 chunks total), search inside one room with 100 different queries.
All tests use a dedicated test collection and a try/finally cleanup.
"""

import os
import sys
import time
import uuid
import logging
from typing import List, Dict, Any

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
    test_collection = f"verify_phase4_{uuid.uuid4().hex[:8]}"
    print("=========================================================================")
    print(f"       CodeSync Phase 4: Code Search Verification ({test_collection})    ")
    print("=========================================================================\n")

    store = QdrantStore(collection_name=test_collection, vector_size=384)
    embedder = get_embedder()

    try:
        # ─────────────────────────────────────────────────────────────────────────
        # Proof 1: Cross-room leakage prevention
        # ─────────────────────────────────────────────────────────────────────────
        print("[Proof 1] Verifying Cross-Room Leakage Prevention...")
        room_a = f"proof-room-alpha-{uuid.uuid4().hex[:6]}"
        room_b = f"proof-room-beta-{uuid.uuid4().hex[:6]}"

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

        # Search in Room A and Room B
        results_a = hybrid_search(room_a, "parseConfig", limit=10, store=store, embedder=embedder)
        results_b = hybrid_search(room_b, "parseConfig", limit=10, store=store, embedder=embedder)

        print(f"Room A search hits: {len(results_a)}, top text: {results_a[0]['text'].strip()[:40]}...")
        print(f"Room B search hits: {len(results_b)}, top text: {results_b[0]['text'].strip()[:40]}...")

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
        room_ident = f"proof-room-ident-{uuid.uuid4().hex[:6]}"
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

        search_ident = hybrid_search(room_ident, "parseConfig", limit=5, store=store, embedder=embedder)
        print(f"Top result for 'parseConfig': {search_ident[0]['function_name']} (score: {search_ident[0]['score']})")

        assert search_ident[0]["function_name"] == "parseConfig", \
            f"Expected parseConfig to rank #1, but got {search_ident[0]['function_name']}"
        print(" PASS: Exact identifier query 'parseConfig' ranks matching function first.\n")

        # ─────────────────────────────────────────────────────────────────────────
        # Proof 3: Keyword-only ranking case (function name unrelated to its body)
        # ─────────────────────────────────────────────────────────────────────────
        print("[Proof 3] Verifying Keyword-Only Ranking (Unrelated Function Name vs Body)...")
        room_kw = f"proof-room-kw-{uuid.uuid4().hex[:6]}"
        kw_code = """
def calculateMortgageAmortization(principal: float, rate: float, term_years: int):
    # Function body is completely unrelated: discussing a banana smoothie recipe
    ingredients = ["ripe bananas", "almond milk", "greek yogurt", "honey"]
    return f"blend {', '.join(ingredients)} until smooth"

def bakeDeliciousApplePie(apples: int):
    # Distractor function body is filled with mortgage and financial terms
    loan_principal = 250000.0
    interest_rate = 0.065
    monthly_payment = loan_principal * (interest_rate / 12)
    return {"mortgage_payment": monthly_payment, "amortization_table": [1, 2, 3]}

def computeGenericHash(value: str):
    return hash(value)
"""
        chunks_kw = chunk_file("finance.py", kw_code, "python")
        vecs_kw = embedder.embed_chunks(chunks_kw)
        store.upsert_chunks(room_kw, "file-kw", "finance.py", chunks_kw, vecs_kw)

        # Searching for 'calculateMortgageAmortization':
        # Vector similarity would favor 'bakeDeliciousApplePie' because of mortgage/amortization in its body.
        # But keyword exact/subtoken match on function_name boosts calculateMortgageAmortization to #1.
        search_kw = hybrid_search(room_kw, "calculateMortgageAmortization", limit=5, store=store, embedder=embedder)
        print(f"Top result for 'calculateMortgageAmortization': {search_kw[0]['function_name']} (score: {search_kw[0]['score']})")

        assert search_kw[0]["function_name"] == "calculateMortgageAmortization", \
            f"Expected calculateMortgageAmortization to rank #1 via keyword boost, got {search_kw[0]['function_name']}"
        print(" PASS: Keyword-only ranking successfully ranks function name even when body is unrelated.\n")

        # ─────────────────────────────────────────────────────────────────────────
        # Proof 4: Embedding cache (0 re-embeds on unchanged, 1 on edit)
        # ─────────────────────────────────────────────────────────────────────────
        print("[Proof 4] Verifying Embedding Cache Hit-Rate & Invalidation...")
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
        # Proof 5: File deletion with shared file_id across two rooms
        # ─────────────────────────────────────────────────────────────────────────
        print("[Proof 5] Verifying delete_file With Shared file_id Across Rooms...")
        del_room_1 = f"room-del-1-{uuid.uuid4().hex[:6]}"
        del_room_2 = f"room-del-2-{uuid.uuid4().hex[:6]}"
        shared_file_id = "shared-file-123"

        c1 = chunk_file("temp.py", "def roomOneCode(): return 'room1'", "python")
        c2 = chunk_file("temp.py", "def roomTwoCode(): return 'room2'", "python")

        v1 = embedder.embed_chunks(c1)
        v2 = embedder.embed_chunks(c2)

        store.upsert_chunks(del_room_1, shared_file_id, "temp.py", c1, v1)
        store.upsert_chunks(del_room_2, shared_file_id, "temp.py", c2, v2)

        assert len(store.search_vectors(del_room_1, v1[0], limit=10)) == 1
        assert len(store.search_vectors(del_room_2, v2[0], limit=10)) == 1

        # Delete from room 1 only
        store.delete_file(del_room_1, shared_file_id)

        count_r1 = len(store.search_vectors(del_room_1, v1[0], limit=10))
        count_r2 = len(store.search_vectors(del_room_2, v2[0], limit=10))
        print(f"After delete in Room 1: Room 1 points = {count_r1}, Room 2 points = {count_r2}")

        assert count_r1 == 0, f"Expected 0 points in Room 1 after delete, got {count_r1}"
        assert count_r2 == 1, f"Expected 1 point preserved in Room 2, got {count_r2}"
        print(" PASS: delete_file(room_id, file_id) safely isolates deletion to target room.\n")

        # ─────────────────────────────────────────────────────────────────────────
        # Proof 6: Cold search latency report (20 rooms x 500 chunks = 10,000 chunks)
        # ─────────────────────────────────────────────────────────────────────────
        num_rooms = 20
        chunks_per_room = 500
        target_room_idx = 7
        target_room_id = f"latency-room-{target_room_idx}"

        print(f"[Proof 6] Seeding {num_rooms} rooms x {chunks_per_room} chunks = {num_rooms * chunks_per_room} total chunks...")

        # Generate 500 distinct code functions
        template_chunks: List[CodeChunk] = []
        for fn_idx in range(chunks_per_room):
            code_str = f"""
def handler_service_fn_{fn_idx}(payload: dict, flag: bool = False):
    '''Service routine {fn_idx} for data aggregation and validation'''
    val = payload.get('metric_{fn_idx % 20}', {fn_idx})
    return val * {fn_idx + 1}
"""
            c = chunk_file(f"service_{fn_idx // 10}.py", code_str, "python")
            template_chunks.extend(c)

        print(f"Generated {len(template_chunks)} base template chunks. Computing embeddings...")
        t_embed_start = time.perf_counter()
        template_vecs = []
        batch_sz = 64
        for i in range(0, len(template_chunks), batch_sz):
            template_vecs.extend(embedder.embed_chunks(template_chunks[i : i + batch_sz]))
        t_embed_end = time.perf_counter()
        print(f"Computed embeddings in {t_embed_end - t_embed_start:.2f}s.")

        print(f"Upserting across {num_rooms} rooms...")
        for r_idx in range(num_rooms):
            rid = f"latency-room-{r_idx}"
            fid = f"file-batch-{r_idx}"
            store.upsert_chunks(rid, fid, "service.py", template_chunks, template_vecs)

        total_collection_points = store.count_chunks()
        room_points = store.count_chunks(target_room_id)
        print(f"Total points in Qdrant collection: {total_collection_points}")
        print(f"Total points in target room '{target_room_id}': {room_points}")
        assert room_points >= 500, f"Expected >= 500 chunks in room, got {room_points}"

        # 100 completely different queries to bypass any query embedding cache
        queries = [
            f"service routine {i} data aggregation metric validation {i * 3}"
            for i in range(100)
        ]

        latencies_ms: List[float] = []
        print(f"Executing 100 cold hybrid searches inside '{target_room_id}' across 10k collection...")
        for q in queries:
            t0 = time.perf_counter()
            _ = hybrid_search(target_room_id, q, limit=10, store=store, embedder=embedder)
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
        print("                 COLD SEARCH LATENCY BENCHMARK REPORT                    ")
        print("=========================================================================")
        print(f"Test Collection:    {test_collection}")
        print(f"Total Index Size:   {total_collection_points} chunks across {num_rooms} rooms")
        print(f"Target Room Size:   {room_points} chunks in '{target_room_id}'")
        print(f"Search Queries:     100 unique cold queries (fresh embeddings + RRF k=60)")
        print(f"Embedding Model:    fastembed (BAAI/bge-small-en-v1.5, 384 dim, ONNX)")
        print("-------------------------------------------------------------------------")
        print(f"Minimum Latency:    {min_lat:.2f} ms")
        print(f"Average Latency:    {avg:.2f} ms")
        print(f"p50 Latency:        {p50:.2f} ms")
        print(f"p95 Latency:        {p95:.2f} ms")
        print(f"p99 Latency:        {p99:.2f} ms")
        print(f"Maximum Latency:    {max_lat:.2f} ms")
        print("=========================================================================\n")
        print(" PASS: Cold latency report completed under required conditions.\n")

    finally:
        print(f"[Cleanup] Deleting dedicated test collection '{test_collection}' from Qdrant...")
        try:
            store.client.delete_collection(test_collection)
            print(f"Successfully deleted test collection '{test_collection}'.")
        except Exception as e:
            print(f"Warning: Cleanup failed for collection '{test_collection}': {e}")

    print("\nAll Phase 4 proofs & benchmarks PASSED successfully!")


if __name__ == "__main__":
    run_all_proofs()
