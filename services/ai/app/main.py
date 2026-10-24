# AI service entrypoint — indexing, retrieval, and the verified fix loop.
# See design doc sections 4 and 5.
from fastapi import FastAPI

app = FastAPI(title="CodeSync AI Service")


@app.get("/health")
def health():
    return {"ok": True}


# TODO: mount routers from app/routes (index, search, fix)
