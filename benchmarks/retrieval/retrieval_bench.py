"""
Phase 6 B3 - retrieval latency and quality, using the production RAG code
(services/ai/app/rag: chunker, FastEmbed bge-small-en-v1.5, QdrantStore, hybrid_search).

    services/ai/.venv/Scripts/python benchmarks/retrieval/retrieval_bench.py [--quick]

QUALITY. One corpus (one room) holding all 25 eval cases: each case's target file AND
its test file. No separate "distractor files" exist in the repo, so the test files are
the distractors (they name the same functions as the targets). Query = the case's bug
description (case_info.json "description"). A result is RELEVANT when it comes from the
case's target file and its line range overlaps the target function's line range (the
same rule for both chunkings). Metrics over the 25 queries: hit@1, hit@3, MRR@10.
Modes: vector-only (QdrantStore.search_vectors), keyword-only (QdrantStore.search_keywords,
which matches the query against function_name), hybrid (search.hybrid_search, RRF k=60).
Chunkings: AST (chunker.chunk_file) vs fixed 40-line windows. Windows have no
function_name, so keyword-only finds nothing on them by construction; it is reported, not
hidden.

LATENCY. 10,000 points across 20 rooms (500 per room) in a separate collection; points are
real embeddings of corpus chunk variants. Queries: the 25 descriptions against random rooms.
Measured: hybrid_search end-to-end (query embedding + room-filtered vector search +
room-filtered keyword search + RRF) and the room-filtered vector search call alone.

Protocol: 1 warm-up + 3 measured runs; results to benchmarks/results/b3-*.json.
Collections used here are bench-only (bench_b3_*) and are deleted at the end.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import random
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
AI_DIR = os.path.join(ROOT, "services", "ai")
sys.path.insert(0, AI_DIR)

from app.rag.chunker import chunk_file, CodeChunk, compute_sha256  # noqa: E402
from app.rag.embedder import get_embedder  # noqa: E402
from app.rag.qdrant_store import QdrantStore  # noqa: E402
from app.rag.search import hybrid_search  # noqa: E402

CASES_DIR = os.path.join(ROOT, "benchmarks", "ai-eval", "cases")
RESULTS_DIR = os.path.join(ROOT, "benchmarks", "results")
WINDOW = 40


# ----------------------------------------------------------------------------- utils
def pct(sorted_vals: List[float], p: float) -> float:
    if not sorted_vals:
        return float("nan")
    rank = math.ceil(p / 100.0 * len(sorted_vals))
    return sorted_vals[min(len(sorted_vals) - 1, max(0, rank - 1))]


def stats(samples: List[float]) -> Dict[str, float]:
    s = sorted(samples)
    r = lambda x: round(x, 2)  # noqa: E731
    return {
        "n": len(s),
        "min": r(s[0]) if s else None,
        "p50": r(pct(s, 50)),
        "p95": r(pct(s, 95)),
        "p99": r(pct(s, 99)),
        "max": r(s[-1]) if s else None,
        "mean": r(sum(s) / len(s)) if s else None,
    }


def sh(cmd: List[str]) -> Optional[str]:
    try:
        out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=30).stdout.strip()
        return out or None
    except Exception:
        return None


def source_digest(dirs: List[str]) -> str:
    h = hashlib.sha256()
    for d in dirs:
        base = os.path.join(ROOT, d)
        for dp, dn, fn in os.walk(base):
            dn[:] = sorted(x for x in dn if x not in ("__pycache__", ".venv", "node_modules", ".pytest_cache"))
            for f in sorted(fn):
                p = os.path.join(dp, f)
                h.update(os.path.relpath(p, ROOT).replace("\\", "/").encode())
                with open(p, "rb") as fh:
                    h.update(fh.read())
    return h.hexdigest()[:16]


def memory_snapshot() -> Dict[str, Any]:
    """Windows memory pressure at benchmark start (see benchmarks/lib/bench.ts memorySnapshot)."""
    if os.name != "nt":
        return {}
    out = sh(["powershell", "-NoProfile", "-Command",
              r"(Get-Counter '\Memory\Available MBytes','\Memory\Committed Bytes','\Memory\Commit Limit','\Memory\Pages/sec').CounterSamples | ForEach-Object { $_.CookedValue }"])
    try:
        v = [float(x) for x in (out or "").split()]
        return {"available_mib": round(v[0]), "committed_gib": round(v[1] / 2 ** 30, 1),
                "commit_limit_gib": round(v[2] / 2 ** 30, 1), "pages_per_sec": round(v[3])}
    except Exception:
        return {"available_mib": None, "note": "counters unavailable"}


MEM_AT_START = None


def envelope(name: str, title: str, conditions: Dict[str, Any], protocol: str, runs: List[Dict[str, Any]],
             summary: Dict[str, Any], notes: List[str], dirs: List[str]) -> str:
    head = sh(["git", "rev-parse", "--verify", "-q", "HEAD"])
    dirty = sh(["git", "status", "--porcelain"])
    try:
        import psutil  # type: ignore
        ram = round(psutil.virtual_memory().total / 2 ** 30, 1)
    except Exception:
        ram = None
    doc = {
        "name": name,
        "title": title,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "git": {
            "commit": head,
            "commit_note": None if head else "branch main has no commits yet; numbers come from the uncommitted working tree",
            "last_pushed_commit": sh(["git", "rev-parse", "--verify", "-q", "origin/main"]),
            "uncommitted_paths": len(dirty.splitlines()) if dirty else 0,
            "source_digest": source_digest(dirs),
            "source_digest_dirs": dirs,
        },
        "environment": {
            "os": f"{platform.system()} {platform.release()} ({platform.machine()})",
            "cpu": platform.processor() or None,
            "logical_cpus": os.cpu_count(),
            "ram_gib": ram,
            "python": platform.python_version(),
            "docker": sh(["docker", "version", "--format", "client {{.Client.Version}} / server {{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})"]),
            "docker_desktop_note": "Qdrant runs in Docker Desktop (WSL2 VM); every query crosses the Windows<->VM boundary" if os.name == "nt" else None,
            "load_generator_shares_machine": True,
            "memory_at_start": MEM_AT_START,
        },
        "conditions": conditions,
        "protocol": protocol,
        "runs": runs,
        "summary": summary,
        "notes": notes,
    }
    os.makedirs(RESULTS_DIR, exist_ok=True)
    path = os.path.join(RESULTS_DIR, f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
    return path


# ----------------------------------------------------------------------------- corpus
def load_cases() -> List[Dict[str, Any]]:
    cases = []
    for d in sorted(os.listdir(CASES_DIR)):
        info_p = os.path.join(CASES_DIR, d, "case_info.json")
        if not os.path.isfile(info_p):
            continue
        with open(info_p, encoding="utf-8") as f:
            info = json.load(f)
        tf = info["target_file"]
        test = ("test_" + tf) if tf.endswith(".py") else tf.replace(".js", ".test.js")
        files = {}
        for fn in (tf, test):
            p = os.path.join(CASES_DIR, d, fn)
            if os.path.isfile(p):
                with open(p, encoding="utf-8") as f:
                    files[fn] = f.read()
        info["dir"] = d
        info["files"] = files
        info["test_file"] = test if test in files else None
        cases.append(info)
    return cases


def window_chunks(path: str, content: str, language: str) -> List[CodeChunk]:
    lines = content.split("\n")
    out = []
    for start in range(0, len(lines), WINDOW):
        text = "\n".join(lines[start:start + WINDOW])
        if not text.strip():
            continue
        out.append(CodeChunk(text=text, ast_type="window", function_name="", language=language,
                             start_line=start + 1, end_line=min(len(lines), start + WINDOW),
                             content_hash=compute_sha256(f"{path}:{start}:{text}")))
    return out


def lang_of(fn: str) -> str:
    return "python" if fn.endswith(".py") else "javascript"


def target_range(case: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    tf = case["target_file"]
    for ch in chunk_file(tf, case["files"][tf], lang_of(tf)):
        if ch.function_name == case["target_function"]:
            return ch.start_line, ch.end_line
    return None


def build_corpus(cases, chunking: str) -> List[Tuple[str, str, CodeChunk]]:
    """[(file_id, path, chunk)] for all target + test files."""
    out = []
    for c in cases:
        for fn, content in c["files"].items():
            path = f"{c['dir']}/{fn}"
            chunks = chunk_file(fn, content, lang_of(fn)) if chunking == "ast" else window_chunks(fn, content, lang_of(fn))
            for ch in chunks:
                out.append((path, path, ch))
    return out


def upsert(store: QdrantStore, room: str, corpus, embedder) -> None:
    by_file: Dict[str, List[CodeChunk]] = {}
    for file_id, path, ch in corpus:
        by_file.setdefault(file_id, []).append(ch)
    for file_id, chunks in by_file.items():
        vecs = embedder.embed_chunks(chunks)
        store.upsert_chunks(room, file_id, file_id, chunks, vecs)


def relevant(item: Dict[str, Any], case: Dict[str, Any], rng: Optional[Tuple[int, int]]) -> bool:
    if item.get("path") != f"{case['dir']}/{case['target_file']}" or rng is None:
        return False
    s, e = item.get("start_line") or 0, item.get("end_line") or 0
    return s <= rng[1] and e >= rng[0]


def evaluate(cases, store, room, embedder, mode: str) -> Dict[str, Any]:
    per_case = []
    for c in cases:
        q = c["description"]
        rng = target_range(c)
        if mode == "vector":
            res = store.search_vectors(room, embedder.embed([q])[0], limit=10)
        elif mode == "keyword":
            res = store.search_keywords(room, q, limit=10)
        else:
            res = hybrid_search(room, q, limit=10, store=store, embedder=embedder)
        rank = next((i + 1 for i, r in enumerate(res) if relevant(r, c, rng)), None)
        per_case.append({"case": c["id"], "rank": rank, "results": len(res),
                         "top1": (f"{res[0].get('path')}:{res[0].get('start_line')}-{res[0].get('end_line')}" if res else None)})
    n = len(per_case)
    return {
        "hit_at_1": round(sum(1 for p in per_case if p["rank"] == 1) / n, 4),
        "hit_at_3": round(sum(1 for p in per_case if p["rank"] and p["rank"] <= 3) / n, 4),
        "mrr_at_10": round(sum((1.0 / p["rank"]) if p["rank"] else 0.0 for p in per_case) / n, 4),
        "queries": n,
        "queries_with_any_result": sum(1 for p in per_case if p["results"] > 0),
        "per_case": per_case,
    }


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--latency-only", action="store_true",
                    help="skip the quality part; resume the 10k latency index if partly built")
    args = ap.parse_args()
    runs_n = 1 if args.quick else 3

    global MEM_AT_START
    MEM_AT_START = memory_snapshot()
    print(f"[B3] memory at start: {MEM_AT_START}")
    cases = load_cases()
    embedder = get_embedder()
    missing_range = [c["id"] for c in cases if target_range(c) is None]
    print(f"[B3] {len(cases)} cases; target function not found by the AST chunker for: {missing_range or 'none'}")

    # ---------------- quality
    quality_files = []
    for chunking in (() if args.latency_only else ("ast", "window40")):
        coll = f"bench_b3_quality_{chunking}"
        store = QdrantStore(collection_name=coll)
        room = "b3-corpus"
        store.delete_room(room)
        corpus = build_corpus(cases, chunking)
        upsert(store, room, corpus, embedder)
        count = store.count_chunks(room)
        print(f"[B3] quality corpus {chunking}: {count} points ({len(corpus)} chunks)")
        runs = []
        for r in range(0, runs_n + 1):  # run 0 = warm-up
            run = {"run": r, "warmup": r == 0, "modes": {m: evaluate(cases, store, room, embedder, m) for m in ("vector", "keyword", "hybrid")}}
            runs.append(run)
            print(f"   {chunking} {'warm-up' if r == 0 else 'run ' + str(r)}: " + "  ".join(
                f"{m}: hit@1={v['hit_at_1']} hit@3={v['hit_at_3']} MRR={v['mrr_at_10']}" for m, v in run["modes"].items()))
        measured = [x for x in runs if not x["warmup"]]
        identical = all(json.dumps(x["modes"], sort_keys=True) == json.dumps(measured[0]["modes"], sort_keys=True) for x in measured)
        quality_files.append(envelope(
            f"b3-retrieval-quality-{chunking}",
            f"Retrieval quality, {'AST chunks' if chunking == 'ast' else 'fixed 40-line windows'}: vector vs keyword vs hybrid",
            {
                "corpus": "25 eval cases: each target file + its test file (test files are the distractors; no other distractor files exist in the repo)",
                "corpus_points": count,
                "chunking": "tree-sitter AST (chunker.chunk_file)" if chunking == "ast" else "fixed 40-line non-overlapping windows, function_name empty",
                "query": "case_info.json description (the bug description)",
                "relevance": "result from the case's target file whose line range overlaps the target function's range",
                "embedder": "FastEmbed BAAI/bge-small-en-v1.5 (384-d, local CPU)",
                "store": "Qdrant (cosine), one room, room_id filter on every query",
                "keyword_mode": "QdrantStore.search_keywords: Qdrant MatchText of the whole query against function_name",
                "hybrid_mode": "search.hybrid_search: RRF (k=60) of vector top-20 and keyword top-20",
                "cut_off": "top 10",
            },
            f"1 warm-up + {runs_n} measured runs over the same 25 queries (deterministic: identical across runs = {identical})",
            runs,
            {m: {k: measured[0]["modes"][m][k] for k in ("hit_at_1", "hit_at_3", "mrr_at_10", "queries", "queries_with_any_result")} for m in ("vector", "keyword", "hybrid")}
            | {"runs_identical": identical},
            [f"Target function not located by the AST chunker for: {missing_range}" if missing_range else "Target function located for all 25 cases."],
            ["services/ai/app/rag", "benchmarks/retrieval", "benchmarks/ai-eval/cases"],
        ))
        store.client.delete_collection(coll)

    # ---------------- latency on 10k points across 20 rooms
    coll = "bench_b3_latency_10k"
    store = QdrantStore(collection_name=coll)
    base = [ch for _, _, ch in build_corpus(cases, "ast")] + [ch for _, _, ch in build_corpus(cases, "window40")]
    rooms = [f"b3-lat-room-{i:02d}" for i in range(20)]
    per_room = 500
    t0 = time.perf_counter()
    rnd = random.Random(42)
    for ri, room in enumerate(rooms):
        # Resume: a room already holding its 500 points is not re-embedded.
        if store.count_chunks(room) >= per_room:
            continue
        chunks = []
        for k in range(per_room):
            src = base[(ri * per_room + k) % len(base)]
            text = f"# variant {ri}-{k}\n{src.text}"
            chunks.append(CodeChunk(text=text, ast_type=src.ast_type, function_name=src.function_name or f"chunk_{k}",
                                    language=src.language, start_line=src.start_line, end_line=src.end_line,
                                    content_hash=compute_sha256(f"{room}:{k}:{text}")))
        for i in range(0, per_room, 100):
            part = chunks[i:i + 100]
            store.upsert_chunks(room, f"{room}-file-{i // 100}", f"file_{i // 100}.py", part, embedder.embed_chunks(part))
    total_points = store.count_chunks()
    print(f"[B3] latency index: {total_points} points in {len(rooms)} rooms, built in {time.perf_counter() - t0:.1f}s")

    queries = [c["description"] for c in cases]
    lat_runs = []
    n_q = 50 if args.quick else 200
    for r in range(0, runs_n + 1):
        hy, vec = [], []
        for i in range(n_q):
            q = queries[i % len(queries)]
            room = rnd.choice(rooms)
            t = time.perf_counter()
            hybrid_search(room, q, limit=10, store=store, embedder=embedder)
            hy.append((time.perf_counter() - t) * 1000)
            qv = embedder.embed([q])[0]
            t = time.perf_counter()
            store.search_vectors(room, qv, limit=20)
            vec.append((time.perf_counter() - t) * 1000)
        lat_runs.append({"run": r, "warmup": r == 0, "samples_ms": [round(x, 3) for x in hy], "stats": stats(hy),
                         "extra": {"vector_search_only_ms": {"samples": [round(x, 3) for x in vec], "stats": stats(vec)}}})
        print(f"   latency {'warm-up' if r == 0 else 'run ' + str(r)}: hybrid p50={stats(hy)['p50']} p95={stats(hy)['p95']} p99={stats(hy)['p99']} ms; "
              f"vector-only p95={stats(vec)['p95']} ms")
    measured = sorted([x for x in lat_runs if not x["warmup"]], key=lambda x: x["stats"]["p50"])
    med = measured[(len(measured) - 1) // 2]
    rng_of = lambda k: {"min": min(x["stats"][k] for x in measured), "max": max(x["stats"][k] for x in measured)}  # noqa: E731
    lat_file = envelope(
        "b3-retrieval-latency-10k",
        "Room-filtered search latency on a 10k-point index across 20 rooms",
        {
            "index_points": total_points,
            "rooms": len(rooms),
            "points_per_room": per_room,
            "points": "real bge-small embeddings of corpus chunk variants (AST + 40-line windows, prefixed per variant)",
            "queries_per_run": n_q,
            "query": "the 25 bug descriptions, cycled; target room chosen at random (seed 42)",
            "samples_ms_is": "hybrid_search end-to-end: query embedding (CPU) + filtered vector search + filtered keyword search + RRF",
            "extra_vector_search_only": "QdrantStore.search_vectors alone (precomputed query vector), limit 20",
            "store": "Qdrant in Docker Desktop, HNSW default params, cosine",
        },
        f"1 warm-up + {runs_n} measured runs of {n_q} queries",
        lat_runs,
        {"median_run": med["run"], "median_stats": med["stats"], "spread": {k: rng_of(k) for k in ("p50", "p95", "p99")},
         "median_run_vector_only_stats": med["extra"]["vector_search_only_ms"]["stats"]},
        [],
        ["services/ai/app/rag", "benchmarks/retrieval"],
    )
    store.client.delete_collection(coll)
    print("wrote:\n  " + "\n  ".join(quality_files + [lat_file]))


if __name__ == "__main__":
    main()
