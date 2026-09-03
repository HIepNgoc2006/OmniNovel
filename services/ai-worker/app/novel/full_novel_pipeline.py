import asyncio
import hashlib
import io
import logging
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any, Callable, Dict, List, Optional, Union

from app.core.ssrf_safe_downloader import safe_download_archive
from app.novel.ast_parser import CanonicalNovelDocument, NovelAstParser
from app.novel.inline_anchors import InlineAnchorCodec, InlineAnchorMap
from app.novel.qa_evaluator import NovelQAResult, NovelQualityGateError, NovelStructuralQAEvaluator
from app.novel.rebuilder import NovelDocumentRebuilder
from app.novel.security import ExtractedEpubChapter, SafeNovelPackageExtractor
from app.novel.segmenter import NovelSegmenter, TranslatableBlock
from app.novel.serializer import NovelDocumentSerializer
from app.novel.translator import NovelTranslationPipeline, NovelTranslationResult
from app.models.manifests import (
    TranslationInputManifestV1,
    NovelResultManifestV1,
    NovelResultAssetModel,
    NovelResultQaModel,
    NovelResultQaIssueModel,
    NovelResultMetricsModel,
)
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
        input_manifest: Optional[Union[TranslationInputManifestV1, Dict[str, Any]]] = None,
        glossary_entries: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Thực thi toàn bộ pipeline xử lý Light Novel end-to-end cho 1 job attempt.
        """
        if glossary_entries is not None:
            effective_glossary = glossary_entries
        elif isinstance(input_manifest, TranslationInputManifestV1):
            effective_glossary = [
                {
                    "sourceTerm": x.sourceTerm,
                    "targetTerm": x.targetTerm,
                    "category": x.category,
                }
                for x in (input_manifest.glossarySnapshot or [])
            ]
        elif isinstance(input_manifest, dict):
            raw_g = input_manifest.get("glossarySnapshot") or input_manifest.get("glossary") or []
            effective_glossary = [
                {
                    "sourceTerm": g.get("sourceTerm") or g.get("source_term", ""),
                    "targetTerm": g.get("targetTerm") or g.get("target_term", ""),
                    "category": g.get("category", "CHARACTER_NAME"),
                }
                if isinstance(g, dict) else g
                for g in raw_g
            ]
        else:
            effective_glossary = []

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
                glossary_entries=effective_glossary,
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
                f"fingerprint_match={qa_result.fingerprint_match}, issues={len(qa_result.issues)}"
            )

            # Invariant P0: Fail-closed QA Gate - Chặn mọi upload/ready nếu QA không đạt
            if not qa_result.passed or not qa_result.fingerprint_match:
                err_msg = (
                    f"Novel Quality Gate Failed: passed={qa_result.passed}, "
                    f"fingerprint_match={qa_result.fingerprint_match}, "
                    f"issues_count={len(qa_result.issues)}"
                )
                logger.error(f"[NovelPipeline] {err_msg}")
                raise NovelQualityGateError(err_msg)

            # -------------------------------------------------------------
            # Stage 4: Upload Outputs & READY_FOR_REVIEW (100%)
            # -------------------------------------------------------------
            uploaded_html_key = f"chapters/{job_id}/novel_translated.html"
            uploaded_assets: List[Dict[str, Any]] = []
            asset_map: Dict[str, str] = {}

            # Xây dựng danh sách upload slots có định kiểu (Typed Content-Type) & fail-closed chống va chạm
            asset_href_to_slot_name: Dict[str, str] = {}
            asset_href_to_content_type: Dict[str, str] = {}
            seen_slot_names: Dict[str, str] = {}

            for href, asset_path in extracted_chapter.image_assets.items():
                cleaned_href = href.strip().lstrip('/')
                href_path = Path(cleaned_href)
                slug_base = re.sub(r'[^a-zA-Z0-9_-]', '_', str(href_path.with_suffix('')) if href_path.suffix else cleaned_href)
                ext = href_path.suffix.lower() if href_path.suffix else asset_path.suffix.lower()
                href_hash = hashlib.sha256(cleaned_href.encode('utf-8')).hexdigest()[:8]
                sanitized_slot_name = f"{slug_base}--{href_hash}{ext}"

                if sanitized_slot_name in seen_slot_names and seen_slot_names[sanitized_slot_name] != href:
                    err = (
                        f"CRITICAL_ASSET_SLOT_COLLISION: Slot name '{sanitized_slot_name}' already claimed by "
                        f"'{seen_slot_names[sanitized_slot_name]}', collided with '{href}'"
                    )
                    logger.error(f"[NovelPipeline] {err}")
                    raise ValueError(err)

                seen_slot_names[sanitized_slot_name] = href
                asset_href_to_slot_name[href] = sanitized_slot_name
                suffix = asset_path.suffix.lower()
                if suffix in ('.png',):
                    content_type = 'image/png'
                elif suffix in ('.jpg', '.jpeg'):
                    content_type = 'image/jpeg'
                elif suffix in ('.webp',):
                    content_type = 'image/webp'
                elif suffix in ('.gif',):
                    content_type = 'image/gif'
                elif suffix in ('.svg',):
                    content_type = 'image/svg+xml'
                else:
                    content_type = 'application/octet-stream'
                asset_href_to_content_type[href] = content_type

            # Đếm số lần xuất hiện của từng basename để chỉ fallback khi basename là duy nhất (unambiguous)
            from collections import Counter
            basename_counts = Counter(Path(h.strip().lstrip('/')).name for h in extracted_chapter.image_assets.keys())

            # Upload qua presigned URL nếu có uploader được cung cấp
            if self.request_upload_urls and self.upload_file:
                # Chuẩn bị danh sách upload slots có typed Content-Type
                file_specs: List[Dict[str, str]] = [
                    {"filename": "novel_translated.html", "contentType": "text/html; charset=utf-8"}
                ]
                for href, slot_name in asset_href_to_slot_name.items():
                    file_specs.append({
                        "filename": slot_name,
                        "contentType": asset_href_to_content_type[href],
                    })

                upload_slots = await self.request_upload_urls(job_id, attempt_number, file_specs)
                slot_map = {s["filename"]: s for s in upload_slots}

                # Upload Asset files và xây dựng asset_map cho serializer
                for href, asset_path in extracted_chapter.image_assets.items():
                    slot_name = asset_href_to_slot_name[href]
                    if slot_name in slot_map:
                        a_slot = slot_map[slot_name]
                        ct = asset_href_to_content_type[href]
                        await self.upload_file(
                            a_slot["uploadUrl"],
                            asset_path.read_bytes(),
                            ct,
                        )
                        storage_key = a_slot["storageKey"]
                        cleaned_h = href.strip().lstrip('/')
                        asset_map[href] = storage_key
                        asset_map[cleaned_h] = storage_key
                        asset_map[slot_name] = storage_key
                        base_name = Path(cleaned_h).name
                        if basename_counts[base_name] == 1:
                            asset_map[base_name] = storage_key

                        uploaded_assets.append(
                            NovelResultAssetModel(
                                storageKey=storage_key,
                                contentType=ct,
                                fileSizeBytes=asset_path.stat().st_size,
                            )
                        )

                # Tuần tự hóa cây AST với asset_map đã ánh xạ storageKey thực tế
                serialized_html = NovelDocumentSerializer.serialize_to_html(
                    translated_doc,
                    asset_map=asset_map,
                )
                output_html_path = work_dir / "translated.html"
                output_html_path.write_text(serialized_html, encoding="utf-8")

                # Upload HTML file với đúng Content-Type text/html; charset=utf-8
                if "novel_translated.html" in slot_map:
                    html_slot = slot_map["novel_translated.html"]
                    await self.upload_file(
                        html_slot["uploadUrl"],
                        output_html_path.read_bytes(),
                        "text/html; charset=utf-8",
                    )
                    uploaded_html_key = html_slot["storageKey"]
            else:
                # Fallback khi test nội bộ không truyền upload helpers
                serialized_html = NovelDocumentSerializer.serialize_to_html(translated_doc)
                output_html_path = work_dir / "translated.html"
                output_html_path.write_text(serialized_html, encoding="utf-8")

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

            html_file_size_bytes = len(output_html_path.read_bytes()) if output_html_path.exists() else 0

            result_manifest = NovelResultManifestV1(
                version=1,
                mediaFormat="NOVEL",
                htmlKey=uploaded_html_key,
                segmentCount=len(segments_payload),
                charCount=sum(len(s.get("translatedText") or "") for s in segments_payload),
                htmlFileSizeBytes=html_file_size_bytes,
                title=translated_doc.title or extracted_chapter.title,
                language=translated_doc.language,
                assets=uploaded_assets if uploaded_assets else None,
                qa=NovelResultQaModel(
                    passed=qa_result.passed,
                    score=qa_result.score,
                    fingerprintMatch=qa_result.fingerprint_match,
                    issuesCount=len(qa_result.issues),
                    issues=[
                        NovelResultQaIssueModel(
                            severity=i.severity.value,
                            ruleId=i.rule_id,
                            message=i.message,
                        )
                        for i in qa_result.issues
                    ],
                ),
                metrics=NovelResultMetricsModel(
                    totalBlocks=translation_result.total_blocks,
                    totalBatches=translation_result.total_batches,
                    glossaryHits=translation_result.glossary_hits,
                    promptVersion=self.prompt_version,
                ),
            )

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
