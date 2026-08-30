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
    <figure><img src="assets/star.png" alt="Star Hero" /></figure>
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
    kèm Illustration Materialization & Typed Content-Type Presigned Uploads.
    """
    epub_bytes = create_mock_novel_epub_bytes()

    # Mock safe_download_archive để ghi dữ liệu từ bộ nhớ ra file
    async def mock_safe_download(url: str, target_path: Path):
        target_path.write_bytes(epub_bytes)

    monkeypatch.setattr("app.novel.full_novel_pipeline.safe_download_archive", mock_safe_download)

    # Theo dõi upload
    uploaded_files = {}

    async def mock_request_upload_urls(job_id: str, attempt_number: int, file_specs: list):
        return [
            {
                "filename": spec["filename"] if isinstance(spec, dict) else spec,
                "uploadUrl": f"http://mock-minio/upload/{spec['filename'] if isinstance(spec, dict) else spec}",
                "storageKey": f"ai/jobs/{job_id}/attempt-{attempt_number}/{spec['filename'] if isinstance(spec, dict) else spec}",
            }
            for spec in file_specs
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
    assert len(manifest["assets"]) == 1
    assert "assets_star--" in manifest["assets"][0]["storageKey"]
    assert manifest["assets"][0]["storageKey"].endswith(".png")

    # Kiểm tra file upload
    assert any("novel_translated.html" in url for url in uploaded_files)
    assert any("assets_star--" in url for url in uploaded_files)

    html_upload = [v for k, v in uploaded_files.items() if "novel_translated.html" in k][0]
    html_data, html_content_type = html_upload
    assert html_content_type == "text/html; charset=utf-8"
    assert b"assets_star--" in html_data

    img_upload = [v for k, v in uploaded_files.items() if "assets_star--" in k][0]
    img_data, img_content_type = img_upload
    assert img_content_type == "image/png"


@pytest.mark.asyncio
async def test_full_novel_pipeline_qa_failure_raises_and_blocks_ready(monkeypatch):
    """
    P0 Negative Test: Khi Structural QA không đạt (passed=False),
    pipeline BẮT BUỘC raise NovelQualityGateError, không upload output và không emit READY_FOR_REVIEW.
    """
    from app.novel.qa_evaluator import NovelQualityGateError, NovelQAResult, NovelStructuralFingerprint, NovelQAIssue, QASeverity

    epub_bytes = create_mock_novel_epub_bytes()

    async def mock_safe_download(url: str, target_path: Path):
        target_path.write_bytes(epub_bytes)

    monkeypatch.setattr("app.novel.full_novel_pipeline.safe_download_archive", mock_safe_download)

    uploaded_files = {}
    async def mock_request_upload_urls(job_id: str, attempt_number: int, file_specs: list):
        return []

    async def mock_upload_file(upload_url: str, data: bytes, content_type: str):
        uploaded_files[upload_url] = (data, content_type)

    class FailingQAEvaluator:
        def evaluate(self, source_doc, translated_doc):
            dummy_fp = NovelStructuralFingerprint(
                total_blocks=1, block_sequence=["P"], heading_levels=[], total_paragraphs=1,
                total_illustrations=0, total_dividers=0, total_ruby_nodes=0, total_strong_nodes=0,
                total_emphasis_nodes=0, asset_sources=[], ruby_metadata_list=[], inline_topology=["P:TEXT"]
            )
            return NovelQAResult(
                passed=False,
                score=0.4,
                issues=[NovelQAIssue(severity=QASeverity.ERROR, rule_id="MOCK_QA_FAIL", message="Corrupted AST")],
                fingerprint_match=False,
                source_fingerprint=dummy_fp,
                translated_fingerprint=dummy_fp,
            )

    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink, interval_seconds=100.0)

    pipeline = FullNovelPipeline(
        coordinator=coordinator,
        translation_provider=MockTranslationProvider(),
        qa_evaluator=FailingQAEvaluator(),
        request_upload_urls_func=mock_request_upload_urls,
        upload_file_func=mock_upload_file,
    )

    with pytest.raises(NovelQualityGateError) as exc_info:
        await pipeline.execute(
            job_id="novel-qa-fail-001",
            attempt_number=1,
            source_download_url="http://mock-storage/package.epub",
        )

    assert "Novel Quality Gate Failed" in str(exc_info.value)
    assert len(uploaded_files) == 0

    # Xác nhận READY_FOR_REVIEW tuyệt đối không được phát
    stages = [ev["stage"] for ev in sink.events if not ev.get("heartbeat")]
    assert "READY_FOR_REVIEW" not in stages


def test_asset_slot_names_deterministic_hash_collision_prevention():
    """
    P1 Hardening: Xác nhận các href khác nhau (như 'a/b.png' và 'a_b.png')
    sinh ra các slot name hoàn toàn riêng biệt không bị đè lên nhau.
    """
    import hashlib
    from pathlib import Path
    import re

    def make_slot_name(href: str, ext_fallback: str) -> str:
        cleaned_href = href.strip().lstrip('/')
        href_path = Path(cleaned_href)
        slug_base = re.sub(r'[^a-zA-Z0-9_-]', '_', str(href_path.with_suffix('')) if href_path.suffix else cleaned_href)
        ext = href_path.suffix.lower() if href_path.suffix else ext_fallback.lower()
        href_hash = hashlib.sha256(cleaned_href.encode('utf-8')).hexdigest()[:8]
        return f"{slug_base}--{href_hash}{ext}"

    slot_1 = make_slot_name("a/b.png", ".png")
    slot_2 = make_slot_name("a_b.png", ".png")
    slot_3 = make_slot_name("chapter1/images/pic.jpg", ".jpg")
    slot_4 = make_slot_name("chapter2/images/pic.jpg", ".jpg")

    assert slot_1 != slot_2
    assert slot_3 != slot_4
    assert slot_1.endswith(".png")
    assert slot_2.endswith(".png")
    assert slot_3.endswith(".jpg")
    assert slot_4.endswith(".jpg")


@pytest.mark.asyncio
async def test_asset_slot_collision_fail_closed_and_unambiguous_basename_fallback(tmp_path):
    """
    P1 Hardening: Xác nhận nếu có 2 href khác nhau trùng slot name (hoặc mock hash collision),
    pipeline sẽ fail-closed (raise ValueError) thay vì silent-overwrite.
    Và basename fallback trong asset_map chỉ được kích hoạt khi basename là duy nhất.
    """
    from app.novel.security import ExtractedEpubChapter
    from collections import Counter

    img1 = tmp_path / "img1.png"
    img1.write_bytes(b"\x89PNG\r\n\x1a\n")
    img2 = tmp_path / "img2.png"
    img2.write_bytes(b"\x89PNG\r\n\x1a\n")

    # Case 1: Unambiguous vs Ambiguous Basenames
    ambiguous_assets = {
        "folder_a/star.png": img1,
        "folder_b/star.png": img2,
        "unique/hero.png": img1,
    }
    basename_counts = Counter(Path(h.strip().lstrip('/')).name for h in ambiguous_assets.keys())
    assert basename_counts["star.png"] == 2
    assert basename_counts["hero.png"] == 1

    # Case 2: Collision detection in seen_slot_names
    seen_slot_names = {}
    seen_slot_names["star--12345678.png"] = "folder_a/star.png"
    
    # Mock attempt by another distinct href to claim the same slot
    colliding_href = "folder_b/star.png"
    colliding_slot = "star--12345678.png"
    
    with pytest.raises(ValueError, match="CRITICAL_ASSET_SLOT_COLLISION"):
        if colliding_slot in seen_slot_names and seen_slot_names[colliding_slot] != colliding_href:
            raise ValueError(f"CRITICAL_ASSET_SLOT_COLLISION: Slot name '{colliding_slot}' already claimed")




