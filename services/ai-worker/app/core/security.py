import secrets
from fastapi import Header, HTTPException, status
from app.core.config import settings

async def verify_internal_key(
    x_internal_service_key: str = Header(None, alias="X-Internal-Service-Key"),
):
    if not x_internal_service_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing internal service secret header: X-Internal-Service-Key",
        )

    # Constant-time comparison chống Timing Attacks
    if not secrets.compare_digest(
        x_internal_service_key, settings.AI_WORKER_SECRET
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal service secret",
        )

    return x_internal_service_key
