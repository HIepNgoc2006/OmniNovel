import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.pipeline.heartbeat_emitter import HeartbeatEmitter
from app.pipeline.manga_pipeline import MangaOcrResult
from app.pipeline.progress_sink import NoopProgressSink, ProgressSink
from app.translation.context_builder import MangaContextBuilder, MangaSegmentItem
from app.translation.glossary_engine import GlossaryEntry, GlossaryEngine
from app.translation.providers.base import (
    TranslationProvider,
    TranslatedSegmentItem,
)
from app.translation.providers.mock_provider import MockTranslationProvider


@dataclass(frozen=True)
class MangaTranslatedSegmentResult:
    page_number: int
    sort_order: int
    bbox_x: int
    bbox_y: int
    bbox_w: int
    bbox_h: int
    raw_text: str
    translated_text: str
    confidence: Optional[float] = None

    @property
    def segment_key(self) -> str:
        return f"p{self.page_number:04d}-s{self.sort_order:04d}"


@dataclass(frozen=True)
class MangaTranslatedPageResult:
    page_number: int
    original_filename: str
    width: int
    height: int
    preview_path: Optional[Path]
    segments: List[MangaTranslatedSegmentResult]


@dataclass(frozen=True)
class MangaTranslationResult:
    pages: List[MangaTranslatedPageResult]
    total_segments: int
    processing_time_ms: float


class MangaTranslationPipeline:
    """
    Vertical Slice 2B: Contextual Translation Pipeline:
    - Tiếp nhận MangaOcrResult (từ Slice 2A) + input_manifest (Glossary snapshot, provider, prompt_version).
    - Tạo định danh segmentKey bất biến, gom nhóm sliding window context theo trang.
    - Khớp GlossaryConstraints không mutate rawText.
    - Dịch qua TranslationProvider với strict 1:1 key mapping validator.
    - Phát tiến độ và Heartbeat định kỳ ở stage TRANSLATING qua ProgressSink.
    - Bảo toàn 100% tọa độ bbox, rawText và confidence nullable.
    """

    def __init__(
        self,
        provider: Optional[TranslationProvider] = None,
        sink: Optional[ProgressSink] = None,
    ):
        self.provider = provider or MockTranslationProvider()
        self.sink = sink or NoopProgressSink()

    async def translate_ocr_result(
        self,
        ocr_result: MangaOcrResult,
        input_manifest: Optional[Dict[str, Any]] = None,
    ) -> MangaTranslationResult:
        start_time = time.perf_counter()
        if hasattr(input_manifest, "model_dump"):
            manifest = input_manifest.model_dump(mode="json")
        else:
            manifest = input_manifest or {}

        # 1. Trích xuất glossary snapshot từ manifest
        raw_glossary = manifest.get("glossarySnapshot", [])
        glossary_entries = [
            GlossaryEntry(
                source_term=g.get("sourceTerm") or g.get("source_term", ""),
                target_term=g.get("targetTerm") or g.get("target_term", ""),
                category=g.get("category", "CHARACTER_NAME"),
            )
            for g in raw_glossary
        ]
        glossary_engine = GlossaryEngine(glossary_entries)
        context_builder = MangaContextBuilder(glossary_engine=glossary_engine)

        prompt_version = manifest.get("promptVersion", "manga-ja-vi-v1")

        # 2. Thu thập toàn bộ MangaSegmentItem
        flat_segments: List[MangaSegmentItem] = []
        for p in ocr_result.pages:
            for s in p.segments:
                flat_segments.append(
                    MangaSegmentItem(
                        page_number=s.page_number,
                        sort_order=s.sort_order,
                        bbox_x=s.bbox_x,
                        bbox_y=s.bbox_y,
                        bbox_w=s.bbox_w,
                        bbox_h=s.bbox_h,
                        raw_text=s.raw_text,
                        confidence=s.confidence,
                    )
                )

        if not flat_segments:
            return MangaTranslationResult(
                pages=[
                    MangaTranslatedPageResult(
                        page_number=p.page_number,
                        original_filename=p.original_filename,
                        width=p.width,
                        height=p.height,
                        preview_path=p.preview_path,
                        segments=[],
                    )
                    for p in ocr_result.pages
                ],
                total_segments=0,
                processing_time_ms=(time.perf_counter() - start_time) * 1000.0,
            )

        # 3. Xây dựng các ContextBatch
        batches = context_builder.build_batches(flat_segments)
        total_batches = len(batches)

        emitter = HeartbeatEmitter(self.sink, stage="TRANSLATING", interval_seconds=15.0)
        emitter.start()

        translated_items_map: Dict[str, str] = {}

        try:
            await self.sink.emit_progress(
                progress=40, stage="TRANSLATING", message="Starting contextual translation"
            )

            for b_idx, batch in enumerate(batches, start=1):
                cur_progress = 40 + int(30 * ((b_idx - 1) / total_batches))
                emitter.set_progress(cur_progress)
                await self.sink.emit_progress(
                    progress=cur_progress,
                    stage="TRANSLATING",
                    message=f"Translating batch {b_idx}/{total_batches}",
                )

                # Thực thi dịch batch qua provider
                batch_results: List[TranslatedSegmentItem] = await self.provider.translate_batch(
                    batch, prompt_version=prompt_version
                )

                for item in batch_results:
                    translated_items_map[item.segment_key] = item.translated_text

            await self.sink.emit_progress(
                progress=70, stage="TRANSLATING", message="Translation completed"
            )

            # 4. Tái cấu trúc kết quả theo từng trang
            translated_pages: List[MangaTranslatedPageResult] = []
            for p in ocr_result.pages:
                page_translated_segments: List[MangaTranslatedSegmentResult] = []
                for s in p.segments:
                    key = f"p{s.page_number:04d}-s{s.sort_order:04d}"
                    trans_text = translated_items_map.get(key, s.raw_text)

                    page_translated_segments.append(
                        MangaTranslatedSegmentResult(
                            page_number=s.page_number,
                            sort_order=s.sort_order,
                            bbox_x=s.bbox_x,
                            bbox_y=s.bbox_y,
                            bbox_w=s.bbox_w,
                            bbox_h=s.bbox_h,
                            raw_text=s.raw_text,
                            translated_text=trans_text,
                            confidence=s.confidence,
                        )
                    )

                translated_pages.append(
                    MangaTranslatedPageResult(
                        page_number=p.page_number,
                        original_filename=p.original_filename,
                        width=p.width,
                        height=p.height,
                        preview_path=p.preview_path,
                        segments=page_translated_segments,
                    )
                )

            elapsed_ms = (time.perf_counter() - start_time) * 1000.0
            return MangaTranslationResult(
                pages=translated_pages,
                total_segments=len(flat_segments),
                processing_time_ms=elapsed_ms,
            )

        finally:
            await emitter.stop()
