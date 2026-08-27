import io
import zipfile
from pathlib import Path
from unittest.mock import MagicMock
import cv2
import numpy as np
from PIL import Image
import pytest

from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
from app.pipeline.full_manga_pipeline import FullMangaPipeline
from app.pipeline.progress_sink import RecordingProgressSink
from app.qa.visual_qa import VisualQAError
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

    async def mock_download(url, target_path, **kwargs):
        import shutil
        shutil.copy(zip_path, target_path)
        return target_path

    monkeypatch.setattr("app.pipeline.full_manga_pipeline.safe_download_archive", mock_download)

    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink)

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
    assert stages == [
        "PREPROCESSING",
        "OCR",
        "TRANSLATING",
        "INPAINTING",
        "TYPESETTING",
        "QUALITY_CHECK",
        "READY_FOR_REVIEW",
    ]


@pytest.mark.asyncio
async def test_full_manga_pipeline_failure_at_inpainting(tmp_path: Path, monkeypatch):
    zip_path = tmp_path / "chapter.zip"
    _create_sample_zip(zip_path)

    async def mock_download(url, target_path, **kwargs):
        import shutil
        shutil.copy(zip_path, target_path)
        return target_path

    monkeypatch.setattr("app.pipeline.full_manga_pipeline.safe_download_archive", mock_download)

    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink)

    pipeline = FullMangaPipeline(
        coordinator=coordinator,
        translation_pipeline=MangaTranslationPipeline(provider=MockTranslationProvider()),
    )

    # Giả lập lỗi tại stage INPAINTING
    pipeline.inpainter.inpaint = MagicMock(side_effect=RuntimeError("Inpainting model failed"))

    with pytest.raises(RuntimeError, match="Inpainting model failed"):
        await pipeline.execute(
            job_id="job-fail-inpaint",
            attempt_number=1,
            source_download_url="http://localhost:9000/media/chapter.zip",
        )

    # Durable state dừng chính xác tại INPAINTING
    assert coordinator.current_stage == "INPAINTING"
    last_stage_event = [e for e in sink.events if not e["heartbeat"]][-1]
    assert last_stage_event["stage"] == "INPAINTING"


@pytest.mark.asyncio
async def test_full_manga_pipeline_failure_at_typesetting(tmp_path: Path, monkeypatch):
    zip_path = tmp_path / "chapter.zip"
    _create_sample_zip(zip_path)

    async def mock_download(url, target_path, **kwargs):
        import shutil
        shutil.copy(zip_path, target_path)
        return target_path

    monkeypatch.setattr("app.pipeline.full_manga_pipeline.safe_download_archive", mock_download)

    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink)

    pipeline = FullMangaPipeline(
        coordinator=coordinator,
        translation_pipeline=MangaTranslationPipeline(provider=MockTranslationProvider()),
    )

    # Giả lập lỗi tại stage TYPESETTING
    pipeline.typesetter.render_page = MagicMock(side_effect=ValueError("Typesetting overflow error"))

    with pytest.raises(ValueError, match="Typesetting overflow error"):
        await pipeline.execute(
            job_id="job-fail-typeset",
            attempt_number=1,
            source_download_url="http://localhost:9000/media/chapter.zip",
        )

    # Durable state dừng chính xác tại TYPESETTING
    assert coordinator.current_stage == "TYPESETTING"
    last_stage_event = [e for e in sink.events if not e["heartbeat"]][-1]
    assert last_stage_event["stage"] == "TYPESETTING"


@pytest.mark.asyncio
async def test_full_manga_pipeline_failure_at_quality_check(tmp_path: Path, monkeypatch):
    zip_path = tmp_path / "chapter.zip"
    _create_sample_zip(zip_path)

    async def mock_download(url, target_path, **kwargs):
        import shutil
        shutil.copy(zip_path, target_path)
        return target_path

    monkeypatch.setattr("app.pipeline.full_manga_pipeline.safe_download_archive", mock_download)

    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink)

    pipeline = FullMangaPipeline(
        coordinator=coordinator,
        translation_pipeline=MangaTranslationPipeline(provider=MockTranslationProvider()),
    )

    # Giả lập lỗi tại stage QUALITY_CHECK
    pipeline.qa.verify_pixel_invariance = MagicMock(side_effect=VisualQAError("Pixel invariance violation"))

    with pytest.raises(VisualQAError, match="Pixel invariance violation"):
        await pipeline.execute(
            job_id="job-fail-qa",
            attempt_number=1,
            source_download_url="http://localhost:9000/media/chapter.zip",
        )

    # Durable state dừng chính xác tại QUALITY_CHECK
    assert coordinator.current_stage == "QUALITY_CHECK"
    last_stage_event = [e for e in sink.events if not e["heartbeat"]][-1]
    assert last_stage_event["stage"] == "QUALITY_CHECK"
