# Consumes stream:ai_indexing events, re-parses via tree-sitter, upserts to Qdrant.
# Debounced on save / ~5s idle (design doc 4.4). Skips unchanged chunks via content_hash.
# TODO: implement.
