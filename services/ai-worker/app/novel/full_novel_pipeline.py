import asyncio
import io
import logging
from pathlib import Path
import shutil
import tempfile
from typing import Any, Callable, Dict, List, Optional

from app.core.ssrf_safe_downloader import safe_download_archive
from app.novel.ast_parser import CanonicalNovelDocument, NovelAstParser
from app.novel.inline_anchors import InlineAnchorCodec, InlineAnchorMap
from app.novel.qa_evaluator import NovelQAResult, NovelStructuralQAEvaluator
from app.novel.rebuilder import NovelDocumentRebuilder
from app.novel.security import ExtractedEpubChapter, SafeNovelPackageExtractor
from app.novel.segmenter import NovelSegmenter, TranslatableBlock
from app.novel.serializer import NovelDocumentSerializer
from app.novel.translator import NovelTranslationPipeline, NovelTranslationResult
from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
from app.translation.providers.base import TranslationProvider
from app.translation.providers.mock_provider import MockTranslationProvider

logger = logging.getLogger(__name__)


class FullNovelPipeline:
    """
    Orchestration trọn vẹn quy trình dịch thuật Light Novel (Checkpoint 3D):
    1. Bounded SSRF download & Safe EPUB/ZIP Sandbox Extraction (PREPROCESSING - 15%)
    2. Canonical AST Parsing & Deterministic Segmentation với Protected Inline Anchors
    3. Shadow Glossary Matching & Sliding Window Context Translation (TRANSLATING - 50%)
    4. Document AST Reconstruction & Strict Structural QA Verification (QUALITY_CHECK - 85%)
    5. HTML5 Context-Aware Serialization, Upload MinIO & READY_FOR_REVIEW (100%)
    """

    def __init__(
        self,
        coordinator: AttemptProgressCoordinator,
        translation_provider: Optional[TranslationProvider] = None,
        qa_evaluator: Optional[NovelStructuralQAEvaluator] = None,
        rebuilder: Optional[NovelDocumentRebuilder] = None,
        request_upload_urls_func: Optional[Callable] = None,
        upload_file_func: Optional[Callable] = None,
        prompt_version: str = "novel-ja-vi-v2",
    ):
        self.coordinator = coordinator
        self.provider = translation_provider or MockTranslationProvider()
        self.translator = NovelTranslationPipeline(
            provider=self.provider,
            prompt_version=prompt_version,
        )
        self.qa = qa_evaluator or NovelStructuralQAEvaluator()
        self.rebuilder = rebuilder or NovelDocumentRebuilder()
        self.request_upload_urls = request_upload_urls_func
        self.upload_file = upload_file_func
        self.prompt_version = prompt_version

    async def execute(
        self,
        job_id: str,
        attempt_number: int,
        source_download_url: str,
        input_manifest: Optional[Dict[str, Any]] = None,
        glossary_entries: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Thực thi toàn bộ pipeline xử lý Light Novel end-to-end cho 1 job attempt.
        """
        manifest = input_manifest or {}
        work_dir = Path(tempfile.mkdtemp(prefix=f"novel_job_{job_id}_att_{attempt_number}_"))

        # Bắt đầu background heartbeat loop
        self.coordinator.start()

        try:
            # -------------------------------------------------------------
            # Stage 1: PREPROCESSING (15%) - Tải và giải nén Sandbox EPUB/ZIP
            # -------------------------------------------------------------
            await self.coordinator.transition_stage(
                stage="PREPROCESSING",
                progress=15,
                message="Downloading and validating novel source package in sandbox",
            )

            archive_target = work_dir / "source_package.epub"
            extracted_dir = work_dir / "extracted"

            # Tải an toàn qua SSRF Downloader
            await safe_download_archive(source_download_url, archive_target)

            # Giải nén an toàn qua SafeNovelPackageExtractor (trong thread pool để không block event loop)
            extracted_chapter: ExtractedEpubChapter = await asyncio.to_thread(
                SafeNovelPackageExtractor.extract_and_validate_epub,
                archive_target,
                extracted_dir,
            )

            # Parse file HTML/XHTML thành Canonical AST Document
            html_raw = extracted_chapter.content_html_path.read_text(encoding="utf-8")
            source_doc: CanonicalNovelDocument = NovelAstParser.parse_html(html_raw)

            # Phân đoạn TranslatableBlocks và trích xuất Protected Inline Anchors
            segmenter = NovelSegmenter()
            blocks, anchor_maps = segmenter.segment_document_with_inline_anchors(source_doc)

            # -------------------------------------------------------------
            # Stage 2: TRANSLATING (50%) - Dịch thuật ngữ cảnh & Glossary
            # -------------------------------------------------------------
            await self.coordinator.transition_stage(
                stage="TRANSLATING",
                progress=50,
                message="Translating novel text with context windowing and protected anchors",
            )

            translation_result: NovelTranslationResult = await self.translator.translate_document(
                document_or_blocks=blocks,
                glossary_entries=glossary_entries or manifest.get("glossary"),
                job_id=job_id,
            )

            # -------------------------------------------------------------
            # Stage 3: QUALITY_CHECK (85%) - Rebuild AST & Structural QA
            # -------------------------------------------------------------
            await self.coordinator.transition_stage(
                stage="QUALITY_CHECK",
                progress=85,
                message="Rebuilding Document AST and evaluating structural QA invariants",
            )

            # Tái tạo Document AST tiếng Việt
            translated_doc: CanonicalNovelDocument = self.rebuilder.rebuild(
                source_doc=source_doc,
                translated_blocks=translation_result.blocks,
                anchor_maps=anchor_maps,
                translated_title=extracted_chapter.title,
            )

            # Thẩm định chất lượng cấu trúc và bảo toàn furigana / inline tags
            qa_result: NovelQAResult = self.qa.evaluate(source_doc, translated_doc)
            logger.info(
                f"[NovelPipeline] QA Evaluator score={qa_result.score}, passed={qa_result.passed}, "
                f"issues={len(qa_result.issues)}"
            )

            # Tuần tự hóa cây AST thành chuỗi HTML5 context-aware auto-escaped
            serialized_html = NovelDocumentSerializer.serialize_to_html(translated_doc)
            output_html_path = work_dir / "translated.html"
            output_html_path.write_text(serialized_html, encoding="utf-8")

            # -------------------------------------------------------------
            # Stage 4: Upload Outputs & READY_FOR_REVIEW (100%)
            # -------------------------------------------------------------
            uploaded_html_key = f"chapters/{job_id}/novel_translated.html"
            uploaded_assets: List[Dict[str, Any]] = []

            # Upload qua presigned URL nếu có uploader được cung cấp
            if self.request_upload_urls and self.upload_file:
                # Xin presigned upload URLs từ Core API
                filenames = ["novel_translated.html"]
                # Thêm danh sách ảnh minh họa nếu có
                for asset_path in extracted_chapter.image_assets.values():
                    filenames.append(asset_path.name)

                upload_slots = await self.request_upload_urls(job_id, attempt_number, filenames)
                slot_map = {s["filename"]: s for s in upload_slots}

                # Upload HTML file
                if "novel_translated.html" in slot_map:
                    html_slot = slot_map["novel_translated.html"]
                    await self.upload_file(
                        html_slot["uploadUrl"],
                        output_html_path.read_bytes(),
                        "text/html; charset=utf-8",
                    )
                    uploaded_html_key = html_slot["storageKey"]

                # Upload Asset files
                for asset_path in extracted_chapter.image_assets.values():
                    if asset_path.name in slot_map:
                        a_slot = slot_map[asset_path.name]
                        await self.upload_file(
                            a_slot["uploadUrl"],
                            asset_path.read_bytes(),
                            "application/octet-stream",
                        )
                        uploaded_assets.append({
                            "filename": asset_path.name,
                            "storageKey": a_slot["storageKey"],
                        })

            # Chuẩn bị segments payload cho biên tập viên duyệt
            segments_payload: List[Dict[str, Any]] = []
            for b in translation_result.blocks:
                segments_payload.append({
                    "sortOrder": b.sort_order,
                    "anchorBlockId": b.anchor_block_id,
                    "blockType": b.block_type,
                    "rawText": b.raw_text,
                    "translatedText": b.translated_text,
                    "confidence": 0.99,
                })

            result_manifest = {
                "mediaFormat": "NOVEL",
                "htmlKey": uploaded_html_key,
                "title": translated_doc.title or extracted_chapter.title,
                "language": translated_doc.language,
                "assets": uploaded_assets,
                "qa": {
                    "passed": qa_result.passed,
                    "score": qa_result.score,
                    "fingerprintMatch": qa_result.fingerprint_match,
                    "issuesCount": len(qa_result.issues),
                    "issues": [
                        {
                            "severity": i.severity.value,
                            "ruleId": i.rule_id,
                            "message": i.message,
                        }
                        for i in qa_result.issues
                    ],
                },
                "metrics": {
                    "totalBlocks": translation_result.total_blocks,
                    "totalBatches": translation_result.total_batches,
                    "glossaryHits": translation_result.glossary_hits,
                    "promptVersion": self.prompt_version,
                },
            }

            # Bắn sự kiện READY_FOR_REVIEW hoàn tất attempt
            await self.coordinator.emit_ready(
                result_manifest=result_manifest,
                segments=segments_payload,
            )

            return {
                "success": True,
                "jobId": job_id,
                "attemptNumber": attempt_number,
                "status": "READY_FOR_REVIEW",
                "resultManifest": result_manifest,
                "segmentsCount": len(segments_payload),
            }

        except Exception as ex:
            logger.error(f"[NovelPipeline] Lỗi trong quá trình xử lý job {job_id}: {ex}", exc_info=True)
            await self.coordinator.stop()
            raise

        finally:
            # Dọn dẹp an toàn thư mục tạm
            if work_dir.exists():
                shutil.rmtree(work_dir, ignore_errors=True)
