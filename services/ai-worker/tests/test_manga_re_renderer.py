"""
Tests for MangaReRenderer Engine (#157).
Verifies:
- RED 6: SHA-256 + SSRF-safe snapshot download & hash verification
- RED 7: Segment adapter & zero OCR/LLM
- RED 8: Lossless WebP & no-segment page rendering
"""

import hashlib
import json
import pytest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException

from app.models.materialize import (
    MaterializeMangaRequest,
    MaterializeMangaPageSlot,
)
from app.pipeline.manga_re_renderer import MangaReRenderer

VALID_JOB_ID = "11111111-1111-4111-8111-111111111111"
VALID_SEG_ID = "22222222-2222-4222-8222-222222222222"


def make_test_snapshot(
    job_id=VALID_JOB_ID,
    target_revision=2,
    media_format="COMIC",
    segments=None,
):
    if segments is None:
        segments = [
            {
                "id": VALID_SEG_ID,
                "version": 1,
                "pageNumber": 1,
                "bboxX": 10.0,
                "bboxY": 20.0,
                "bboxW": 100.0,
                "bboxH": 50.0,
                "anchorBlockId": None,
                "sortOrder": 0,
                "rawText": "こんにちは",
                "translatedText": "Xin chào",
                "blockType": None,
            }
        ]
    return {
        "version": 1,
        "jobId": job_id,
        "targetRevision": target_revision,
        "mediaFormat": media_format,
        "segments": segments,
    }


def make_request(snapshot_sha256: str, target_revision: int = 2):
    return MaterializeMangaRequest(
        jobId=VALID_JOB_ID,
        targetRevision=target_revision,
        snapshotUrl="http://localhost:9000/bucket/snapshots/snapshot.json",
        snapshotSha256=snapshot_sha256,
        pages=[
            MaterializeMangaPageSlot(
                pageNumber=1,
                cleanBaseUrl="http://localhost:9000/bucket/clean/p1.png",
                outputUploadUrl="http://localhost:9000/bucket/output/page_1.webp",
                storageKey="output/page_1.webp",
            )
        ],
    )


class TestMangaReRendererRed6Sha256AndDownload:
    @pytest.mark.asyncio
    async def test_raises_400_when_snapshot_hash_mismatches(self):
        snapshot_dict = make_test_snapshot()
        raw_bytes = json.dumps(snapshot_dict).encode("utf-8")
        actual_sha256 = hashlib.sha256(raw_bytes).hexdigest()
        different_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

        req = make_request(snapshot_sha256=different_sha256)
        renderer = MangaReRenderer()

        with patch("app.pipeline.manga_re_renderer.safe_download_bytes", new_callable=AsyncMock) as mock_dl:
            mock_dl.return_value = raw_bytes

            with pytest.raises(HTTPException) as exc:
                await renderer.re_render_manga(req)

            assert exc.value.status_code == 400
            assert "SNAPSHOT_HASH_MISMATCH" in str(exc.value.detail)

    @pytest.mark.asyncio
    async def test_raises_400_when_snapshot_job_id_or_revision_mismatches(self):
        # Snapshot has different jobId
        snapshot_dict = make_test_snapshot(job_id="99999999-9999-4999-8999-999999999999")
        raw_bytes = json.dumps(snapshot_dict).encode("utf-8")
        actual_sha256 = hashlib.sha256(raw_bytes).hexdigest()

        req = make_request(snapshot_sha256=actual_sha256)
        renderer = MangaReRenderer()

        with patch("app.pipeline.manga_re_renderer.safe_download_bytes", new_callable=AsyncMock) as mock_dl:
            mock_dl.return_value = raw_bytes

            with pytest.raises(HTTPException) as exc:
                await renderer.re_render_manga(req)

            assert exc.value.status_code == 400
            assert "SNAPSHOT_INVARIANT_MISMATCH" in str(exc.value.detail)
