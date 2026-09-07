import hashlib
import logging
from typing import Optional
from fastapi import HTTPException, status

from app.core.ssrf_safe_downloader import safe_download_bytes, validate_download_url
from app.models.materialize import (
    MaterializeMangaRequest,
    MaterializationSnapshotV1,
)

logger = logging.getLogger(__name__)


class MangaReRenderer:
    """
    Engine re-render Manga text tiếng Việt lên clean base:
    - Zero OCR / Zero LLM
    - Typesets segments onto clean bases
    - Lossless WebP output
    """

    def __init__(self):
        pass

    async def re_render_manga(self, request: MaterializeMangaRequest) -> None:
        """
        Thực hiện re-render Manga:
        1. Tải & thẩm định SHA-256 snapshot trước khi parse
        2. Validate snapshot invariants
        3. Iterate pages, render text, upload lossless WebP
        4. Callback về Core API
        """
        # 1. Tải snapshot qua SSRF-safe downloader
        raw_snapshot = await safe_download_bytes(request.snapshot_url)

        # 2. Verify Content-Addressed SHA-256
        actual_sha256 = hashlib.sha256(raw_snapshot).hexdigest()
        if actual_sha256 != request.snapshot_sha256:
            logger.error(
                f"[MangaReRenderer] SHA-256 mismatch cho job {request.job_id}: "
                f"expected {request.snapshot_sha256}, actual {actual_sha256}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"SNAPSHOT_HASH_MISMATCH: expected {request.snapshot_sha256}, got {actual_sha256}",
            )

        # 3. Parse Strict Snapshot V1
        try:
            snapshot = MaterializationSnapshotV1.model_validate_json(raw_snapshot)
        except Exception as e:
            logger.error(f"[MangaReRenderer] Lỗi parse snapshot V1: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"INVALID_SNAPSHOT_PAYLOAD: {str(e)}",
            )

        # 4. Thẩm định Snapshot Invariants
        if (
            snapshot.jobId != request.job_id
            or snapshot.targetRevision != request.target_revision
            or snapshot.mediaFormat != "COMIC"
        ):
            logger.error(
                f"[MangaReRenderer] Snapshot invariants mismatch cho job {request.job_id}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="SNAPSHOT_INVARIANT_MISMATCH: snapshot metadata does not match request",
            )

