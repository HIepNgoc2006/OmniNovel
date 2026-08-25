from fastapi import FastAPI
from app.api.v1.endpoints.jobs import router as jobs_router
from app.core.config import settings

app = FastAPI(
    title="OmniNovel AI Worker Engine",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
)

app.include_router(
    jobs_router, prefix="/internal/v1/jobs", tags=["Internal Jobs"]
)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app", host="0.0.0.0", port=settings.AI_WORKER_PORT, reload=True
    )
