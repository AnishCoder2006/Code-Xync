# AI service
FastAPI + LangGraph + Qdrant + tree-sitter. Handles code indexing, hybrid retrieval,
and the verified AI fix loop (never writes to the live document directly).
Run: `pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000`
(requires Redis + Qdrant running).
