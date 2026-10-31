"""
Unit tests for app.rag.embedder:
- embed behind swappable interface
- cache by content_hash: unchanged file = 0 re-embeds, 1 edited function = 1 re-embed
"""

import pytest
from app.rag.chunker import CodeChunk
from app.rag.embedder import CachedEmbedder, DummyEmbedder


def test_embedder_caching():
    dummy = DummyEmbedder(dimension=64)
    cached = CachedEmbedder(embedder=dummy)

    chunk1 = CodeChunk(
        text="def foo(): return 1",
        ast_type="function",
        function_name="foo",
        language="python",
        start_line=1,
        end_line=2,
        content_hash="hash_foo_1",
    )
    chunk2 = CodeChunk(
        text="def bar(): return 2",
        ast_type="function",
        function_name="bar",
        language="python",
        start_line=3,
        end_line=4,
        content_hash="hash_bar_1",
    )

    # First embed: 2 misses, 0 hits
    embeddings = cached.embed_chunks([chunk1, chunk2])
    assert len(embeddings) == 2
    assert cached.total_misses == 2
    assert cached.total_hits == 0

    # Re-indexing unchanged file: 2 hits, 0 new misses
    embeddings2 = cached.embed_chunks([chunk1, chunk2])
    assert len(embeddings2) == 2
    assert cached.total_misses == 2
    assert cached.total_hits == 2
    assert embeddings == embeddings2

    # Edit one function (chunk2 edited -> chunk2_modified with new hash):
    chunk2_mod = CodeChunk(
        text="def bar(): return 42",
        ast_type="function",
        function_name="bar",
        language="python",
        start_line=3,
        end_line=4,
        content_hash="hash_bar_2",
    )

    # Re-indexing should hit chunk1 (cache) and miss chunk2_mod (exactly 1 re-embed)
    prev_misses = cached.total_misses
    embeddings3 = cached.embed_chunks([chunk1, chunk2_mod])
    assert len(embeddings3) == 2
    assert cached.total_misses == prev_misses + 1  # exactly 1 new miss
    assert cached.total_hits == 3  # chunk1 hit again

    stats = cached.get_stats()
    assert stats["cached_items"] == 3
    assert stats["total_hits"] == 3
    assert stats["total_misses"] == 3
    assert stats["hit_rate_pct"] == 50.0
