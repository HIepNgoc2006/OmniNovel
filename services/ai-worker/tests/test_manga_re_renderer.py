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


def make_dummy_png_bytes(width=200, height=300):
    import io
    from PIL import Image
    img = Image.new("RGB", (width, height), color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestMangaReRendererRed7SegmentAdapterAndZeroOcr:
    @pytest.mark.asyncio
    async def test_segment_adapter_rounds_coords_and_calls_typesetter_without_ocr_or_llm(self):
        snapshot_dict = make_test_snapshot(
            segments=[
                {
                    "id": VALID_SEG_ID,
                    "version": 1,
                    "pageNumber": 1,
                    "bboxX": 10.4,
                    "bboxY": 20.6,
                    "bboxW": 100.2,
                    "bboxH": 50.9,
                    "anchorBlockId": None,
                    "sortOrder": 0,
                    "rawText": "こんにちは",
                    "translatedText": "Xin chào",
                    "blockType": None,
                }
            ]
        )
        raw_snapshot = json.dumps(snapshot_dict).encode("utf-8")
        actual_sha256 = hashlib.sha256(raw_snapshot).hexdigest()

        req = make_request(snapshot_sha256=actual_sha256)

        mock_typesetter = AsyncMock()
        import numpy as np
        dummy_img = np.full((300, 200, 3), 255, dtype=np.uint8)
        mock_typesetter.render_page = AsyncMock(return_value=(dummy_img, None)) if False else \
            lambda img, segs: (img, None)
        from unittest.mock import MagicMock
        magic_typesetter = MagicMock()
        magic_typesetter.render_page.return_value = (dummy_img, None)

        renderer = MangaReRenderer(typesetter=magic_typesetter)

        uploaded_content = {}
        async def mock_download(url, *args, **kwargs):
            if "snapshot" in url:
                return raw_snapshot
            return make_dummy_png_bytes(200, 300)

        import httpx
        def mock_client_handler(request: httpx.Request):
            if request.method == "PUT":
                uploaded_content["put_url"] = str(request.url)
                uploaded_content["content_type"] = request.headers.get("content-type")
                uploaded_content["bytes"] = request.content
                return httpx.Response(200)
            elif request.method == "POST":
                uploaded_content["post_url"] = str(request.url)
                uploaded_content["post_json"] = json.loads(request.content)
                return httpx.Response(200, json={"status": "COMPLETED"})
            return httpx.Response(404)

        test_client = httpx.AsyncClient(transport=httpx.MockTransport(mock_client_handler))

        with patch("app.pipeline.manga_re_renderer.safe_download_bytes", side_effect=mock_download):
            with patch("httpx.AsyncClient", return_value=test_client):
                await renderer.re_render_manga(req)

        # 1. Verify typesetter was called with rounded coordinates
        magic_typesetter.render_page.assert_called_once()
        args, kwargs = magic_typesetter.render_page.call_args
        adapted_segments = args[1]
        assert len(adapted_segments) == 1
        seg = adapted_segments[0]
        assert seg.bbox_x == 10
        assert seg.bbox_y == 21
        assert seg.bbox_w == 100
        assert seg.bbox_h == 51
        assert seg.page_number == 1
        assert seg.translated_text == "Xin chào"

        # 2. Invariant: ZERO OCR / LLM imports or calls
        assert not hasattr(renderer, "ocr")
        assert not hasattr(renderer, "detector")
        assert not hasattr(renderer, "translator")


class TestMangaReRendererRed8LosslessWebPAndNoSegmentPage:
    @pytest.mark.asyncio
    async def test_lossless_webp_upload_and_empty_segment_page(self):
        # 2 pages: page 1 has segment, page 2 has NO segments
        snapshot_dict = make_test_snapshot(
            segments=[
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
        )
        raw_snapshot = json.dumps(snapshot_dict).encode("utf-8")
        actual_sha256 = hashlib.sha256(raw_snapshot).hexdigest()

        req = MaterializeMangaRequest(
            jobId=VALID_JOB_ID,
            targetRevision=2,
            snapshotUrl="http://localhost:9000/bucket/snapshots/snapshot.json",
            snapshotSha256=actual_sha256,
            pages=[
                MaterializeMangaPageSlot(
                    pageNumber=1,
                    cleanBaseUrl="http://localhost:9000/bucket/clean/p1.png",
                    outputUploadUrl="http://localhost:9000/bucket/output/page_1.webp",
                    storageKey="output/page_1.webp",
                ),
                MaterializeMangaPageSlot(
                    pageNumber=2,
                    cleanBaseUrl="http://localhost:9000/bucket/clean/p2.png",
                    outputUploadUrl="http://localhost:9000/bucket/output/page_2.webp",
                    storageKey="output/page_2.webp",
                ),
            ],
        )

        import numpy as np
        dummy_img = np.full((300, 200, 3), 255, dtype=np.uint8)
        from unittest.mock import MagicMock
        magic_typesetter = MagicMock()
        magic_typesetter.render_page.return_value = (dummy_img, None)

        renderer = MangaReRenderer(typesetter=magic_typesetter)

        uploaded_requests = []
        callback_request = {}

        async def mock_download(url, *args, **kwargs):
            if "snapshot" in url:
                return raw_snapshot
            return make_dummy_png_bytes(200, 300)

        import httpx
        def mock_client_handler(request: httpx.Request):
            if request.method == "PUT":
                uploaded_requests.append({
                    "url": str(request.url),
                    "content_type": request.headers.get("content-type"),
                    "bytes": request.content,
                })
                return httpx.Response(200)
            elif request.method == "POST":
                callback_request["url"] = str(request.url)
                callback_request["headers"] = dict(request.headers)
                callback_request["payload"] = json.loads(request.content)
                return httpx.Response(200, json={"status": "COMPLETED"})
            return httpx.Response(404)

        test_client = httpx.AsyncClient(transport=httpx.MockTransport(mock_client_handler))

        with patch("app.pipeline.manga_re_renderer.safe_download_bytes", side_effect=mock_download):
            with patch("httpx.AsyncClient", return_value=test_client):
                await renderer.re_render_manga(req)

        # 1. Typesetter only called once (for page 1, NOT for page 2)
        assert magic_typesetter.render_page.call_count == 1

        # 2. Both pages uploaded as image/webp
        assert len(uploaded_requests) == 2
        for upload in uploaded_requests:
            assert upload["content_type"] == "image/webp"
            import io
            from PIL import Image
            img = Image.open(io.BytesIO(upload["bytes"]))
            assert img.format == "WEBP"
            assert img.size == (200, 300)

        # 3. Callback sent to Core API with canonical URL
        from app.core.config import settings
        expected_callback_url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{VALID_JOB_ID}/materializations/complete"
        assert callback_request["url"] == expected_callback_url
        assert callback_request["headers"]["x-internal-service-key"] == settings.AI_WORKER_SECRET
        payload = callback_request["payload"]
        assert payload["targetRevision"] == 2
        assert payload["mediaFormat"] == "COMIC"
        assert len(payload["result"]["pages"]) == 2
        assert payload["result"]["pages"][0]["page"] == 1
        assert payload["result"]["pages"][1]["page"] == 2

