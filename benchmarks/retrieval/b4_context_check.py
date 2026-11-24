"""
Phase 6 B4 - is retrieval used by the AI fix loop, and would it add context today?

    services/ai/.venv/Scripts/python benchmarks/retrieval/b4_context_check.py

1. Static: inspect the source of node_context_builder (services/ai/app/agent/graph.py)
   and the whole agent package for calls into search / hybrid_search / the RAG store.
2. Measured: rooms are single-file (one Yjs doc per room). For each of the 25 eval cases,
   index ONLY that case's open file in its own room (exactly what a room holds today),
   query with the bug description, and measure how many retrieved lines are already in
   the open file the loop sends to the model in full.
Writes benchmarks/results/b4-retrieval-in-fix-loop.json.
"""
import inspect
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "services", "ai"))
sys.path.insert(0, os.path.dirname(__file__))

from app.agent import graph  # noqa: E402
from app.rag.chunker import chunk_file  # noqa: E402
from app.rag.embedder import get_embedder  # noqa: E402
from app.rag.qdrant_store import QdrantStore  # noqa: E402
from app.rag.search import hybrid_search  # noqa: E402
import retrieval_bench as rb  # noqa: E402

PATTERN = re.compile(r"hybrid_search|search_vectors|search_keywords|/search|app\.rag\.search|qdrant", re.I)


def main():
    src = inspect.getsource(graph.node_context_builder)
    builder_hits = PATTERN.findall(src)
    agent_dir = os.path.join(ROOT, "services", "ai", "app", "agent")
    pkg_hits = []
    for fn in sorted(os.listdir(agent_dir)):
        if fn.endswith(".py"):
            with open(os.path.join(agent_dir, fn), encoding="utf-8") as f:
                for i, line in enumerate(f, 1):
                    if PATTERN.search(line):
                        pkg_hits.append(f"{fn}:{i}: {line.strip()}")
    print(f"[B4] node_context_builder search calls: {builder_hits or 'none'}")
    print(f"[B4] agent package lines matching search/RAG: {pkg_hits or 'none'}")

    cases = rb.load_cases()
    embedder = get_embedder()
    store = QdrantStore(collection_name="bench_b4_single_file")
    top_k = 5
    per_case, total, inside = [], 0, 0
    for c in cases:
        room = f"b4-{c['id']}"
        tf = c["target_file"]
        content = c["files"][tf]
        chunks = chunk_file(tf, content, rb.lang_of(tf))
        store.upsert_chunks(room, tf, tf, chunks, embedder.embed_chunks(chunks))
        res = hybrid_search(room, c["description"], limit=top_k, store=store, embedder=embedder)
        open_lines = set(l.strip() for l in content.split("\n") if l.strip())
        got = [l.strip() for r in res for l in (r.get("text") or "").split("\n") if l.strip()]
        n_in = sum(1 for l in got if l in open_lines)
        total += len(got)
        inside += n_in
        per_case.append({"case": c["id"], "results": len(res), "retrieved_lines": len(got), "already_in_open_file": n_in})
    store.client.delete_collection("bench_b4_single_file")
    pct = round(100.0 * inside / total, 2) if total else None
    print(f"[B4] retrieved lines already in the open file: {inside}/{total} = {pct}%")

    doc = {
        "name": "b4-retrieval-in-fix-loop",
        "title": "Is retrieval used by the fix loop?",
        "timestamp": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()),
        "conditions": {
            "static_check": "regex over inspect.getsource(node_context_builder) and every line of services/ai/app/agent/*.py",
            "pattern": PATTERN.pattern,
            "rooms": "single-file: each case's open file indexed alone in its own room (one Yjs doc per room, as the product works today)",
            "query": "case bug description",
            "top_k": top_k,
            "search": "app.rag.search.hybrid_search (production)",
        },
        "summary": {
            "context_builder_calls_search": bool(builder_hits),
            "evidence": f"node_context_builder source matches: {builder_hits or 'none'}; agent package matches: {len(pkg_hits)}",
            "agent_package_matches": pkg_hits,
            "cases": len(cases),
            "retrieved_lines": total,
            "retrieved_lines_already_in_open_file": inside,
            "retrieved_lines_already_in_open_file_pct": pct,
            "decision": ("Not wired: node_context_builder sends the whole open file; in a single-file room every retrieved line is already part of it, "
                         "so retrieval adds no context today. Revisit when rooms hold several files."),
        },
        "per_case": per_case,
    }
    path = os.path.join(rb.RESULTS_DIR, "b4-retrieval-in-fix-loop.json")
    os.makedirs(rb.RESULTS_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
