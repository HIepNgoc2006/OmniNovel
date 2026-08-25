import asyncio
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional
import cv2
import numpy as np

from app.core.package_extractor import ExtractedPageRef, extract_chapter_package
from app.pipeline.detector import MangaBubbleDetector
from app.pipeline.heartbeat_emitter import HeartbeatEmitter
from app.pipeline.ocr_engine import MangaOcrEngine
from app.pipeline.preview import SegmentPreviewItem, generate_ocr_debug_preview
from app.pipeline.progress_sink import NoopProgressSink, ProgressSink
from app.pipeline.reading_order import sort_manga_reading_order


@dataclass(frozen=True)
class MangaOcrSegmentResult:
    page_number: int
    sort_order: int
    bbox_x: int
    bbox_y: int
    bbox_w: int
    bbox_h: int
    raw_text: str
    confidence: Optional[float] = None


@dataclass(frozen=True)
class MangaOcrPageResult:
    page_number: int
    original_filename: str
    width: int
    height: int
    preview_path: Optional[Path]
    segments: List[MangaOcrSegmentResult]


@dataclass(frozen=True)
class MangaOcrResult:
    pages: List[MangaOcrPageResult]
    total_segments: int
    processing_time_ms: float


class MangaOcrPipeline:
    """
    Vertical Slice 2A: Standalone Japanese Manga-OCR Pipeline:
    1. Extract ZIP an toàn với Zip-Bomb / Traversal / PIL Limits (chạy to_thread)
    2. OpenCV Bubble & Text Region Detection (chạy to_thread)
    3. Deterministic RTL + TTB Reading Order Heuristic
    4. Manga-OCR Inference dưới concurrency lock & cache cô lập
    5. WebP OCR Debug Preview Generation (chạy to_thread)
    6. Heartbeat & Progress Emitter độc lập qua ProgressSink
    7. Tự động dọn dẹp thư mục giải nén tạm trong finally block
    """

    def __init__(
        self,
        detector: Optional[MangaBubbleDetector] = None,
        engine: Optional[MangaOcrEngine] = None,
        sink: Optional[ProgressSink] = None,
    ):
        self.detector = detector or MangaBubbleDetector()
        self.engine = engine or MangaOcrEngine.get_instance()
        self.sink = sink or NoopProgressSink()

    async def process_extracted_pages(
        self,
        extracted_pages: List[ExtractedPageRef],
        work_dir: Optional[Path] = None,
        generate_previews: bool = False,
    ) -> MangaOcrResult:
        """Thực hiện OCR trực tiếp trên danh sách ExtractedPageRef đã giải nén."""
        start_time = time.perf_counter()
        total_pages = len(extracted_pages)
        page_results: List[MangaOcrPageResult] = []
        all_segments_count = 0

        preview_dir = (work_dir / "previews") if work_dir else None
        if generate_previews and preview_dir:
            preview_dir.mkdir(parents=True, exist_ok=True)

        for p_idx, page in enumerate(extracted_pages, start=1):
            # Đọc ảnh an toàn
            raw_bytes = np.fromfile(str(page.file_path), dtype=np.uint8)
            full_img = cv2.imdecode(raw_bytes, cv2.IMREAD_COLOR)
            if full_img is None:
                raise ValueError(f"Failed to read image from {page.file_path}")

            # Phát hiện vùng thoại trong threadpool
            detected_regions = await asyncio.to_thread(
                self.detector.detect_regions, page.file_path
            )

            # Sắp xếp thứ tự đọc Manga RTL / TTB
            ordered_regions = sort_manga_reading_order(
                detected_regions, page.width, page.height
            )

            page_segments: List[MangaOcrSegmentResult] = []
            preview_items: List[SegmentPreviewItem] = []

            for s_idx, r in enumerate(ordered_regions, start=1):
                x, y, w, h = r.bbox_x, r.bbox_y, r.bbox_w, r.bbox_h
                crop = full_img[y : y + h, x : x + w]
                recognized_text = await self.engine.recognize_crop_async(crop)

                seg_result = MangaOcrSegmentResult(
                    page_number=page.page_number,
                    sort_order=s_idx,
                    bbox_x=x,
                    bbox_y=y,
                    bbox_w=w,
                    bbox_h=h,
                    raw_text=recognized_text,
                    confidence=None,  # SSoT: Manga-OCR không sinh confidence giả định
                )
                page_segments.append(seg_result)
                preview_items.append(SegmentPreviewItem(sort_order=s_idx, region=r))

            preview_path: Optional[Path] = None
            if generate_previews and preview_dir:
                preview_file = preview_dir / f"page_{page.page_number:04d}_preview.webp"
                await asyncio.to_thread(
                    generate_ocr_debug_preview, page.file_path, preview_items, preview_file
                )
                preview_path = preview_file

            all_segments_count += len(page_segments)
            page_results.append(
                MangaOcrPageResult(
                    page_number=page.page_number,
                    original_filename=page.original_filename,
                    width=page.width,
                    height=page.height,
                    preview_path=preview_path,
                    segments=page_segments,
                )
            )

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        return MangaOcrResult(
            pages=page_results,
            total_segments=all_segments_count,
            processing_time_ms=elapsed_ms,
        )

    async def process_chapter_package(
        self,
        zip_path: Path,
        work_dir: Path,
        generate_previews: bool = True,
        cleanup_extracted: bool = True,
    ) -> MangaOcrResult:
        emitter = HeartbeatEmitter(self.sink, stage="OCR", interval_seconds=15.0)
        emitter.start()
        extracted_dir = work_dir / "extracted"

        try:
            # 1. Giải nén an toàn trong threadpool
            await self.sink.emit_progress(progress=10, stage="OCR", message="Extracting source ZIP archive")
            extracted_pages: List[ExtractedPageRef] = await asyncio.to_thread(
                extract_chapter_package, zip_path, extracted_dir
            )

            await self.sink.emit_progress(progress=30, stage="OCR", message="Running OCR inference")
            result = await self.process_extracted_pages(
                extracted_pages=extracted_pages,
                work_dir=work_dir,
                generate_previews=generate_previews,
            )

            await self.sink.emit_progress(progress=95, stage="OCR", message="OCR processing completed")
            return result

        finally:
            await emitter.stop()
            if cleanup_extracted and extracted_dir.exists():
                await asyncio.to_thread(shutil.rmtree, extracted_dir, ignore_errors=True)
