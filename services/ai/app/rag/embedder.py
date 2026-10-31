"""
Embedding interface and cache for CodeSync RAG.
Defaults to local fastembed BAAI/bge-small-en-v1.5.
Switchable by env var EMBEDDING_PROVIDER.
Caches embeddings by content_hash to avoid re-embedding unchanged chunks.
See design doc section 4.2 / 4.4.
"""

import abc
import os
import logging
from typing import List, Dict, Optional, Tuple, Any

logger = logging.getLogger(__name__)


class BaseEmbedder(abc.ABC):
    """Swappable embedding provider interface."""

    @abc.abstractmethod
    def embed(self, texts: List[str]) -> List[List[float]]:
        """Embed a batch of text strings into vector representations."""
        pass

    @property
    @abc.abstractmethod
    def dimension(self) -> int:
        """Vector dimension."""
        pass


class FastEmbedEmbedder(BaseEmbedder):
    """Local embedding provider using fastembed with BAAI/bge-small-en-v1.5."""

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5"):
        from fastembed import TextEmbedding
        self.model_name = model_name
        logger.info(f"Initializing FastEmbed model: {model_name}")
        self.model = TextEmbedding(model_name=model_name)
        self._dim = 384

    def embed(self, texts: List[str], batch_size: int = 32) -> List[List[float]]:
        if not texts:
            return []
        all_embeddings: List[List[float]] = []
        for i in range(0, len(texts), batch_size):
            chunk = texts[i : i + batch_size]
            embeddings = list(self.model.embed(chunk, batch_size=batch_size))
            all_embeddings.extend([e.tolist() if hasattr(e, "tolist") else list(e) for e in embeddings])
        return all_embeddings

    @property
    def dimension(self) -> int:
        return self._dim


class DummyEmbedder(BaseEmbedder):
    """Deterministic dummy embedder for lightweight unit testing."""

    def __init__(self, dimension: int = 384):
        self._dim = dimension

    def embed(self, texts: List[str]) -> List[List[float]]:
        import hashlib
        results = []
        for text in texts:
            h = hashlib.sha256(text.encode("utf-8")).digest()
            # Expand to dimension
            vec = [(h[i % len(h)] / 255.0) for i in range(self._dim)]
            results.append(vec)
        return results

    @property
    def dimension(self) -> int:
        return self._dim


class CachedEmbedder:
    """
    Embedding service with content_hash-based in-memory caching.
    Skips re-embedding unchanged chunks and logs cache hit rate.
    """

    def __init__(self, embedder: Optional[BaseEmbedder] = None):
        if embedder is None:
            provider = os.getenv("EMBEDDING_PROVIDER", "fastembed").lower()
            if provider == "fastembed":
                self.embedder: BaseEmbedder = FastEmbedEmbedder()
            elif provider == "dummy":
                self.embedder = DummyEmbedder()
            else:
                logger.warning(f"Unknown EMBEDDING_PROVIDER '{provider}'. Defaulting to FastEmbedEmbedder.")
                self.embedder = FastEmbedEmbedder()
        else:
            self.embedder = embedder

        self.cache: Dict[str, List[float]] = {}
        self.total_hits = 0
        self.total_misses = 0

    @property
    def dimension(self) -> int:
        return self.embedder.dimension

    def embed(self, texts: List[str]) -> List[List[float]]:
        """Direct embedding without hashes (e.g. for search queries)."""
        return self.embedder.embed(texts)

    def embed_chunks(self, chunks: List[Any]) -> List[List[float]]:
        """
        Embed a list of CodeChunk objects using their content_hash.
        Only chunks whose content_hash is not in cache are passed to the model.
        Logs cache hit rate and returns vectors in the exact input order.
        """
        if not chunks:
            return []

        results: List[Optional[List[float]]] = [None] * len(chunks)
        miss_indices: List[int] = []
        miss_texts: List[str] = []
        batch_hits = 0
        batch_misses = 0

        for idx, chunk in enumerate(chunks):
            chash = getattr(chunk, "content_hash", None)
            if chash and chash in self.cache:
                results[idx] = self.cache[chash]
                batch_hits += 1
            else:
                miss_indices.append(idx)
                text = getattr(chunk, "text", str(chunk))
                miss_texts.append(text)
                batch_misses += 1

        self.total_hits += batch_hits
        self.total_misses += batch_misses

        # If there are cache misses, embed them in batch
        if miss_texts:
            new_embeddings = self.embedder.embed(miss_texts)
            for idx, emb in zip(miss_indices, new_embeddings):
                results[idx] = emb
                chash = getattr(chunks[idx], "content_hash", None)
                if chash:
                    self.cache[chash] = emb

        # Log cache hit rate
        total_requests = self.total_hits + self.total_misses
        hit_rate = (self.total_hits / total_requests * 100.0) if total_requests > 0 else 0.0
        logger.info(
            f"Embedding cache: {batch_hits} hits, {batch_misses} misses in batch | "
            f"Overall: {self.total_hits}/{total_requests} ({hit_rate:.1f}% hit rate)"
        )

        return [res for res in results if res is not None]

    def get_stats(self) -> Dict[str, Any]:
        total = self.total_hits + self.total_misses
        return {
            "cached_items": len(self.cache),
            "total_hits": self.total_hits,
            "total_misses": self.total_misses,
            "hit_rate_pct": (self.total_hits / total * 100.0) if total > 0 else 0.0,
        }

    def clear_cache(self):
        self.cache.clear()
        self.total_hits = 0
        self.total_misses = 0


# Global singleton instance
_default_embedder: Optional[CachedEmbedder] = None


def get_embedder() -> CachedEmbedder:
    global _default_embedder
    if _default_embedder is None:
        _default_embedder = CachedEmbedder()
    return _default_embedder
