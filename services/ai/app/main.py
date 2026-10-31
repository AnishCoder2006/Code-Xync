"""
AI service entrypoint — indexing, retrieval, and the verified fix loop.
See design doc sections 4 and 5.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.routes.search import router as search_router
from app.routes.indexing import router as indexing_router, start_indexing_worker, stop_indexing_worker


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start stream consumer background worker
    start_indexing_worker()
    yield
    # Stop background worker on shutdown
    stop_indexing_worker()


app = FastAPI(title="CodeSync AI Service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True, "service": "codesync-ai"}


app.include_router(search_router)
app.include_router(indexing_router)
