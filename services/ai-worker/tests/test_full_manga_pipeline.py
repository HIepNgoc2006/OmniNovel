import io
import zipfile
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
import pytest

from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
from app.pipeline.full_manga_pipeline import FullMangaPipeline
from app.pipeline.progress_sink import RecordingProgressSink
from app.translation.manga_translator import MangaTranslationPipeline
from app.translation.providers.mock_provider import MockTranslationProvider


def _create_manga_test_page_bytes(text: str = "こんにちは") -> bytes:
    """Tạo 1 ảnh manga mẫu có bubble trắng và chữ đen."""
    img = np.full((600, 400, 3), 200, dtype=np.uint8)  # Nền xám
    cv2.ellipse(img, (200, 300), (100, 120), 0, 0, 360, (255, 255, 255), -1)
    cv2.ellipse(img, (200, 300), (100, 120), 0, 0, 360, (0, 0, 0), 2)
    cv2.putText(img, text, (150, 290), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)

    _, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def _create_sample_zip(target_path: Path) -> Path:
    with zipfile.ZipFile(target_path, "w") as zf:
        zf.writestr("page_01.png", _create_manga_test_page_bytes("HELLO"))
        zf.writestr("page_02.png", _create_manga_test_page_bytes("WORLD"))
    return target_path


@pytest.mark.asyncio
async def test_full_manga_pipeline_execution_all_stages(tmp_path: Path, monkeypatch):
    zip_path = tmp_path / "chapter.zip"
    _create_sample_zip(zip_path)

    # Monkeypatch safe_download_archive để copy từ file cục bộ cho test
    async def mock_download(url, target_path, **kwargs):
        import shutil
        shutil.copy(zip_path, target_path)
        return target_path

    monkeypatch.setattr("app.pipeline.full_manga_pipeline.safe_download_archive", mock_download)

    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink)

    # Mock upload helpers
    uploaded_payloads = {}

    async def mock_request_upload_urls(job_id, attempt_num, filenames):
        return [
            {
                "filename": fn,
                "storageKey": f"ai/jobs/{job_id}/attempt-{attempt_num}/{fn}",
                "uploadUrl": f"http://localhost:9000/upload/{fn}",
            }
            for fn in filenames
        ]

    async def mock_upload_file(url, data, content_type):
        uploaded_payloads[url] = data

    pipeline = FullMangaPipeline(
        coordinator=coordinator,
        translation_pipeline=MangaTranslationPipeline(provider=MockTranslationProvider()),
        upload_urls_requester=mock_request_upload_urls,
        uploader_func=mock_upload_file,
    )

    manifest = {
        "sourceLang": "ja",
        "targetLang": "vi",
        "glossarySnapshot": [
            {"sourceTerm": "HELLO", "targetTerm": "Xin chào"},
        ],
    }

    result = await pipeline.execute(
        job_id="job-uuid-123",
        attempt_number=1,
        source_download_url="http://localhost:9000/media/chapter.zip",
        input_manifest=manifest,
    )

    assert result["success"] is True
    assert result["status"] == "READY_FOR_REVIEW"
    assert result["pagesProcessed"] == 2

    # Kiểm tra chuỗi các stages trong events
    stages = [e["stage"] for e in sink.events if not e["heartbeat"]]
    assert "PREPROCESSING" in stages
    assert "OCR" in stages
    assert "TRANSLATING" in stages
    assert "INPAINTING" in stages
    assert "TYPESETTING" in stages
    assert "QUALITY_CHECK" in stages
    assert "READY_FOR_REVIEW" in stages

    # Invariant: Các stage trước READY_FOR_REVIEW không chứa segments
    for ev in sink.events[:-1]:
        assert ev["segments"] == []

    # Final event READY_FOR_REVIEW mang segments và manifest
    last_event = sink.events[-1]
    assert last_event["stage"] == "READY_FOR_REVIEW"
    assert len(last_event["resultManifest"]["pages"]) == 2
    assert len(uploaded_payloads) == 2
