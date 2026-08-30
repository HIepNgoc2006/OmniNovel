import io
from pathlib import Path
import tempfile
import zipfile
import pytest

from app.novel.full_novel_pipeline import FullNovelPipeline
from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
from app.pipeline.progress_sink import RecordingProgressSink
from app.translation.providers.mock_provider import MockTranslationProvider


def create_mock_novel_epub_bytes() -> bytes:
    """Tạo một file EPUB/ZIP hợp lệ trong bộ nhớ phục vụ test pipeline."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # mimetype
        z.writestr("mimetype", "application/epub+zip")
        # container.xml
        container_xml = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>"""
        z.writestr("META-INF/container.xml", container_xml)

        # content.opf
        content_opf = """<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Chapter 1: The Awakening</dc:title>
    </metadata>
    <manifest>
        <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
        <item id="img1" href="assets/star.png" media-type="image/png"/>
    </manifest>
    <spine>
        <itemref idref="chapter1"/>
    </spine>
</package>"""
        z.writestr("OEBPS/content.opf", content_opf)

        # chapter1.xhtml
        chapter1_xhtml = """<!DOCTYPE html>
<html>
<head><title>Chapter 1</title></head>
<body>
    <h1>第1章 覚醒</h1>
    <p>彼は<strong>勇者</strong>であり、<ruby>魔王<rt>まおう</rt></ruby>を討つ者だ。</p>
    <p>「行くぞ！」</p>
</body>
</html>"""
        z.writestr("OEBPS/chapter1.xhtml", chapter1_xhtml)
        z.writestr("OEBPS/assets/star.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82")

    return buf.getvalue()


@pytest.mark.asyncio
async def test_full_novel_pipeline_execution_e2e(monkeypatch):
    """
    Test FullNovelPipeline thực thi trọn vẹn:
    PREPROCESSING -> TRANSLATING -> QUALITY_CHECK -> READY_FOR_REVIEW
    """
    epub_bytes = create_mock_novel_epub_bytes()

    # Mock safe_download_archive để ghi dữ liệu từ bộ nhớ ra file
    async def mock_safe_download(url: str, target_path: Path):
        target_path.write_bytes(epub_bytes)

    monkeypatch.setattr("app.novel.full_novel_pipeline.safe_download_archive", mock_safe_download)

    # Theo dõi upload
    uploaded_files = {}

    async def mock_request_upload_urls(job_id: str, attempt_number: int, filenames: list):
        return [
            {
                "filename": fn,
                "uploadUrl": f"http://mock-minio/upload/{fn}",
                "storageKey": f"chapters/{job_id}/{fn}",
            }
            for fn in filenames
        ]

    async def mock_upload_file(upload_url: str, data: bytes, content_type: str):
        uploaded_files[upload_url] = (data, content_type)

    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink, interval_seconds=100.0)

    pipeline = FullNovelPipeline(
        coordinator=coordinator,
        translation_provider=MockTranslationProvider(),
        request_upload_urls_func=mock_request_upload_urls,
        upload_file_func=mock_upload_file,
        prompt_version="novel-ja-vi-v2",
    )

    glossary = [
        {"source_term": "魔王", "target_term": "Ma Vương", "category": "character"}
    ]

    res = await pipeline.execute(
        job_id="novel-test-job-001",
        attempt_number=1,
        source_download_url="http://mock-storage/package.epub",
        glossary_entries=glossary,
    )

    assert res["success"] is True
    assert res["status"] == "READY_FOR_REVIEW"
    assert res["segmentsCount"] == 3

    # Kiểm tra events phát ra
    stages = [ev["stage"] for ev in sink.events if not ev.get("heartbeat")]
    assert "PREPROCESSING" in stages
    assert "TRANSLATING" in stages
    assert "QUALITY_CHECK" in stages
    assert stages[-1] == "READY_FOR_REVIEW"

    # Kiểm tra Result Manifest
    last_event = [ev for ev in sink.events if ev["stage"] == "READY_FOR_REVIEW"][-1]
    manifest = last_event["resultManifest"]
    assert manifest["mediaFormat"] == "NOVEL"
    assert manifest["qa"]["passed"] is True
    assert manifest["qa"]["fingerprintMatch"] is True
    assert manifest["metrics"]["promptVersion"] == "novel-ja-vi-v2"

    # Kiểm tra Segments
    segments = last_event["segments"]
    assert len(segments) == 3
    assert segments[0]["anchorBlockId"] == "blk_0001_h1"
    assert segments[1]["anchorBlockId"] == "blk_0002_p"
    assert segments[2]["anchorBlockId"] == "blk_0003_dlg"

    # Kiểm tra file upload
    assert any("novel_translated.html" in url for url in uploaded_files)
    html_upload = [v for k, v in uploaded_files.items() if "novel_translated.html" in k][0]
    html_data, content_type = html_upload
    assert content_type == "text/html; charset=utf-8"
    assert b"<html" in html_data.lower()
    assert b"<ruby" in html_data.lower() or b"Ma V" in html_data or b"D" in html_data
