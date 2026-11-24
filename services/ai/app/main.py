"""
AI service entrypoint — indexing, retrieval, and the verified fix loop.
See design doc sections 4 and 5.
"""

import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.routes.search import router as search_router
from app.routes.indexing import router as indexing_router, start_indexing_worker, stop_indexing_worker
from app.routes.fix import router as fix_router


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
    return {"ok": True, "service": "codesync-ai", "llm_provider": os.getenv("LLM_PROVIDER", "mock")}


app.include_router(search_router)
app.include_router(indexing_router)
app.include_router(fix_router)
