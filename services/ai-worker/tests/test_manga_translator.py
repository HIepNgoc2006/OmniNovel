from pathlib import Path
import pytest

from app.pipeline.manga_pipeline import (
    MangaOcrPageResult,
    MangaOcrResult,
    MangaOcrSegmentResult,
)
from app.pipeline.progress_sink import RecordingProgressSink
from app.translation.manga_translator import MangaTranslationPipeline
from app.translation.providers.mock_provider import MockTranslationProvider


@pytest.mark.asyncio
async def test_manga_translation_pipeline_end_to_end():
    # 1. Tạo MangaOcrResult giả lập gồm 2 trang, mỗi trang 2 segments
    seg1 = MangaOcrSegmentResult(
        page_number=1, sort_order=1, bbox_x=10, bbox_y=20, bbox_w=100, bbox_h=50, raw_text="海賊王に俺はなる！", confidence=None
    )
    seg2 = MangaOcrSegmentResult(
        page_number=1, sort_order=2, bbox_x=120, bbox_y=20, bbox_w=80, bbox_h=40, raw_text="こんにちは", confidence=None
    )
    page1 = MangaOcrPageResult(
        page_number=1, original_filename="page_0001.png", width=800, height=1200, preview_path=Path("/tmp/p1.webp"), segments=[seg1, seg2]
    )

    seg3 = MangaOcrSegmentResult(
        page_number=2, sort_order=1, bbox_x=15, bbox_y=30, bbox_w=90, bbox_h=45, raw_text="世界を救う勇者", confidence=None
    )
    page2 = MangaOcrPageResult(
        page_number=2, original_filename="page_0002.png", width=800, height=1200, preview_path=Path("/tmp/p2.webp"), segments=[seg3]
    )

    ocr_result = MangaOcrResult(pages=[page1, page2], total_segments=3, processing_time_ms=150.0)

    # 2. Input manifest có glossary snapshot
    manifest = {
        "sourceLang": "ja",
        "targetLang": "vi",
        "provider": "MOCK",
        "model": "mock-model-v1",
        "promptVersion": "manga-ja-vi-v1",
        "glossarySnapshot": [
            {"sourceTerm": "海賊王", "targetTerm": "Vua Hải Tặc", "category": "TITLE"},
            {"sourceTerm": "勇者", "targetTerm": "Dũng sĩ", "category": "ROLE"},
        ],
        "glossaryHash": "sha256:dummyhash",
    }

    sink = RecordingProgressSink()
    pipeline = MangaTranslationPipeline(provider=MockTranslationProvider(), sink=sink)

    result = await pipeline.translate_ocr_result(ocr_result, input_manifest=manifest)

    # 3. Kiểm tra kết quả
    assert result.total_segments == 3
    assert len(result.pages) == 2

    # Trang 1
    p1_res = result.pages[0]
    assert len(p1_res.segments) == 2
    # Invariant: Tọa độ, rawText, confidence không thay đổi
    assert p1_res.segments[0].bbox_x == 10
    assert p1_res.segments[0].raw_text == "海賊王に俺はなる！"
    assert p1_res.segments[0].confidence is None
    assert "Vua Hải Tặc" in p1_res.segments[0].translated_text

    assert p1_res.segments[1].raw_text == "こんにちは"
    assert "Xin chào" in p1_res.segments[1].translated_text

    # Trang 2
    p2_res = result.pages[1]
    assert len(p2_res.segments) == 1
    assert p2_res.segments[0].bbox_x == 15
    assert p2_res.segments[0].raw_text == "世界を救う勇者"
    assert "Dũng sĩ" in p2_res.segments[0].translated_text
    assert "Thế giới" in p2_res.segments[0].translated_text

    # 4. Kiểm tra Progress Events
    stages = [e["stage"] for e in sink.events]
    assert "TRANSLATING" in stages
    assert any(e["progress"] >= 40 for e in sink.events)
    assert any(e["progress"] >= 70 for e in sink.events)


@pytest.mark.asyncio
async def test_manga_translation_pipeline_empty_pages():
    ocr_result = MangaOcrResult(pages=[], total_segments=0, processing_time_ms=0.0)
    pipeline = MangaTranslationPipeline(provider=MockTranslationProvider())

    result = await pipeline.translate_ocr_result(ocr_result)
    assert result.total_segments == 0
    assert len(result.pages) == 0
