"""
Runs the 10 benchmark bug-fix cases against the CodeSync search engine.
Checks that the search returns the buggy function in its top 3 results for each case.
Prints the detailed per-case results and overall top-3 hit rate.
See design doc section 7.1.
"""

import os
import sys
import json
import logging
from typing import List, Dict, Any

# Ensure services/ai is on sys.path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AI_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "services", "ai"))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

from app.rag.chunker import chunk_file
from app.rag.embedder import get_embedder
from app.rag.qdrant_store import get_qdrant_store
from app.rag.search import hybrid_search

logging.basicConfig(level=logging.ERROR)


def run_benchmark():
    print("=========================================================================================")
    print("             CodeSync Phase 4: AI Code Search Benchmark Evaluation (10 Cases)             ")
    print("=========================================================================================\n")

    cases_dir = os.path.join(BASE_DIR, "cases")
    store = get_qdrant_store()
    embedder = get_embedder()

    case_dirs = sorted([d for d in os.listdir(cases_dir) if os.path.isdir(os.path.join(cases_dir, d))])

    total_cases = len(case_dirs)
    top1_hits = 0
    top3_hits = 0
    results: List[Dict[str, Any]] = []

    for cdir in case_dirs:
        case_path = os.path.join(cases_dir, cdir)
        info_path = os.path.join(case_path, "case_info.json")
        if not os.path.exists(info_path):
            continue

        with open(info_path, "r", encoding="utf-8") as f:
            info = json.load(f)

        case_id = info["id"]
        target_file = info["target_file"]
        target_function = info["target_function"]
        query = info["query"]
        eval_room_id = f"eval-room-{case_id}"
        eval_file_id = f"file-{case_id}"

        # Read source code
        source_path = os.path.join(case_path, target_file)
        with open(source_path, "r", encoding="utf-8") as f:
            source_code = f.read()

        # 1. Chunk and index into Qdrant for this isolated room
        chunks = chunk_file(target_file, source_code)
        embeddings = embedder.embed_chunks(chunks)
        store.upsert_chunks(eval_room_id, eval_file_id, target_file, chunks, embeddings)

        # 2. Run hybrid search
        search_results = hybrid_search(eval_room_id, query, limit=5)

        # 3. Check rank of target_function
        found_rank = None
        for rank, res in enumerate(search_results, start=1):
            if res["function_name"].lower() == target_function.lower():
                found_rank = rank
                break

        top1 = found_rank == 1
        top3 = found_rank is not None and found_rank <= 3

        if top1:
            top1_hits += 1
        if top3:
            top3_hits += 1

        top1_fn = search_results[0]["function_name"] if search_results else "NONE"

        results.append({
            "case_id": case_id,
            "target": target_function,
            "top1_returned": top1_fn,
            "rank": found_rank if found_rank else ">5",
            "top3_hit": "PASS" if top3 else "FAIL",
        })

        # Cleanup test room points from Qdrant
        store.delete_room(eval_room_id)

    # Print Table
    print("-----------------------------------------------------------------------------------------")
    print(f"| {'Case ID':<25} | {'Target Function':<25} | {'Top-1 Returned':<20} | {'Rank':<5} | {'Top-3':<5} |")
    print("-----------------------------------------------------------------------------------------")
    for r in results:
        print(f"| {r['case_id']:<25} | {r['target']:<25} | {r['top1_returned']:<20} | {str(r['rank']):<5} | {r['top3_hit']:<5} |")
    print("-----------------------------------------------------------------------------------------\n")

    top3_rate = (top3_hits / total_cases * 100.0) if total_cases > 0 else 0.0
    top1_rate = (top1_hits / total_cases * 100.0) if total_cases > 0 else 0.0

    print(f"Total Cases:     {total_cases}")
    print(f"Top-1 Hits:      {top1_hits}/{total_cases} ({top1_rate:.1f}%)")
    print(f"Top-3 Hit Rate:  {top3_hits}/{total_cases} ({top3_rate:.1f}%)")
    print("=========================================================================================\n")

    if top3_hits < total_cases:
        sys.exit(1)


if __name__ == "__main__":
    run_benchmark()
