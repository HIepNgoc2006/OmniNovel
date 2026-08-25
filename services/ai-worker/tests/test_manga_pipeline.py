import io
import zipfile
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
import pytest

from app.pipeline.detector import MangaBubbleDetector
from app.pipeline.manga_pipeline import MangaOcrPipeline
from app.pipeline.ocr_engine import MangaOcrEngine
from app.pipeline.progress_sink import RecordingProgressSink


class StubMangaOcr:
    def __call__(self, img):
        return "こんにちは世界"


def _create_manga_page_image_bytes(width=1000, height=1500) -> bytes:
    img = np.ones((height, width, 3), dtype=np.uint8) * 255
    # Bong bóng 1
    cv2.rectangle(img, (600, 100), (800, 250), (0, 0, 0), 3)
    cv2.putText(img, "JP 1", (620, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
    # Bong bóng 2
    cv2.rectangle(img, (100, 120), (350, 300), (0, 0, 0), 3)
    cv2.putText(img, "JP 2", (120, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)

    buf = io.BytesIO()
    pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    pil_img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_manga_ocr_pipeline_end_to_end(tmp_path: Path):
    zip_path = tmp_path / "chapter_source.zip"
    work_dir = tmp_path / "work"

    # 1. Tạo ZIP source package 2 trang
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("p1.jpg", _create_manga_page_image_bytes())
        zf.writestr("p2.jpg", _create_manga_page_image_bytes())

    # 2. Chuẩn bị Pipeline với mock engine và recording sink
    engine = MangaOcrEngine()
    engine.set_mock_model(StubMangaOcr())
    sink = RecordingProgressSink()
    pipeline = MangaOcrPipeline(
        detector=MangaBubbleDetector(min_area=500, min_dim=20),
        engine=engine,
        sink=sink,
    )

    # 3. Chạy pipeline
    result = await pipeline.process_chapter_package(
        zip_path=zip_path,
        work_dir=work_dir,
        generate_previews=True,
    )

    # 4. Kiểm tra kết quả MangaOcrResult
    assert len(result.pages) == 2
    assert result.total_segments >= 4
    assert result.processing_time_ms > 0

    p1 = result.pages[0]
    assert p1.page_number == 1
    assert p1.width == 1000
    assert p1.height == 1500
    assert p1.preview_path is not None
    assert p1.preview_path.exists()
    assert p1.preview_path.suffix == ".webp"

    # Kiểm tra preview ảnh WebP hợp lệ
    preview_img = Image.open(p1.preview_path)
    assert preview_img.format == "WEBP"
    assert preview_img.size == (1000, 1500)

    # Kiểm tra segments
    for seg in p1.segments:
        assert seg.page_number == 1
        assert seg.sort_order >= 1
        assert seg.bbox_x >= 0
        assert seg.bbox_y >= 0
        assert seg.bbox_w > 0
        assert seg.bbox_h > 0
        assert seg.raw_text == "こんにちは世界"
        assert seg.confidence is None  # Invariant: null confidence

    # Kiểm tra progress events
    stages = [e["stage"] for e in sink.events]
    assert all(s == "OCR" for s in stages)
    assert sink.events[-1]["progress"] == 95
