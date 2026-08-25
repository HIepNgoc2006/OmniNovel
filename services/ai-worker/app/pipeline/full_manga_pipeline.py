import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
import cv2

from app.core.config import settings
from app.core.package_extractor import extract_chapter_package
from app.core.ssrf_safe_downloader import safe_download_archive
from app.inpainting.inpainter import MangaInpainter
from app.inpainting.mask_generator import generate_text_stroke_mask
from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
from app.pipeline.manga_pipeline import MangaOcrPipeline, MangaOcrResult
from app.qa.visual_qa import VisualQAEvaluator
from app.translation.manga_translator import MangaTranslationPipeline, MangaTranslationResult
from app.translation.providers.base import TranslationProvider
from app.typesetting.typesetter import MangaTypesetter


class FullMangaPipeline:
    """
    Orchestration trọn vẹn của quy trình sản xuất Manga (Vertical Slice 2C):
    1. Bounded SSRF download & Safe ZIP extraction (PREPROCESSING - 10%)
    2. Bubble Detection & Japanese Manga-OCR (OCR - 30%)
    3. Contextual Translation & Glossary Constraints (TRANSLATING - 50%)
    4. Text-Stroke Mask Generation & Inpainting (INPAINTING - 70%)
    5. Vietnamese Typesetting & Dynamic Fitting (TYPESETTING - 85%)
    6. Mechanical Visual QA & WebP Encoding (QUALITY_CHECK - 95%)
    7. Two-Step Presigned Upload & Final READY_FOR_REVIEW Callback (100%)
    """

    def __init__(
        self,
        coordinator: AttemptProgressCoordinator,
        ocr_pipeline: Optional[MangaOcrPipeline] = None,
        translation_pipeline: Optional[MangaTranslationPipeline] = None,
        inpainter: Optional[MangaInpainter] = None,
        typesetter: Optional[MangaTypesetter] = None,
        qa_evaluator: Optional[VisualQAEvaluator] = None,
        upload_urls_requester: Optional[Callable] = None,
        uploader_func: Optional[Callable] = None,
    ):
        self.coordinator = coordinator
        self.ocr_pipeline = ocr_pipeline or MangaOcrPipeline()
        self.translation_pipeline = translation_pipeline or MangaTranslationPipeline()
        self.inpainter = inpainter or MangaInpainter()
        self.typesetter = typesetter or MangaTypesetter()
        self.qa = qa_evaluator or VisualQAEvaluator()
        self.request_upload_urls = upload_urls_requester
        self.upload_file = uploader_func

    async def execute(
        self,
        job_id: str,
        attempt_number: int,
        source_download_url: str,
        input_manifest: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        manifest = input_manifest or {}
        work_dir = Path(tempfile.mkdtemp(prefix=f"manga_job_{job_id}_att_{attempt_number}_"))

        # Bắt đầu background heartbeat loop đồng bộ
        self.coordinator.start()

        try:
            # 1. PREPROCESSING: Tải an toàn và giải nén source package
            await self.coordinator.transition_stage(
                stage="PREPROCESSING",
                progress=10,
                message="Downloading and validating source package",
            )

            zip_target = work_dir / "source.zip"
            extracted_dir = work_dir / "extracted"

            await safe_download_archive(source_download_url, zip_target)
            extracted_pages = extract_chapter_package(zip_target, extracted_dir)

            # 2. OCR: Phát hiện bubble và nhận diện chữ tiếng Nhật
            await self.coordinator.transition_stage(
                stage="OCR",
                progress=30,
                message="Running bubble detection and Japanese Manga-OCR",
            )
            ocr_result: MangaOcrResult = await self.ocr_pipeline.process_extracted_pages(
                extracted_pages=extracted_pages,
                work_dir=work_dir,
            )

            # 3. TRANSLATING: Dịch thuật ngữ cảnh và áp dụng glossary constraints
            await self.coordinator.transition_stage(
                stage="TRANSLATING",
                progress=50,
                message="Executing contextual translation with glossary constraints",
            )
            translation_result: MangaTranslationResult = (
                await self.translation_pipeline.translate_ocr_result(
                    ocr_result=ocr_result,
                    input_manifest=manifest,
                )
            )

            # 4. INPAINTING: Sinh text-stroke mask và inpaint xóa chữ gốc
            await self.coordinator.transition_stage(
                stage="INPAINTING",
                progress=70,
                message="Generating text-stroke masks and inpainting speech bubbles",
            )

            inpainted_pages_bgr: List[cv2.Mat] = []
            source_pages_bgr: List[cv2.Mat] = []
            inpaint_masks: List[cv2.Mat] = []

            for page_idx, page_trans in enumerate(translation_result.pages):
                page_ref = extracted_pages[page_idx]
                src_bgr = cv2.imread(str(page_ref.file_path))
                if src_bgr is None:
                    raise ValueError(f"Không thể đọc file ảnh nguồn tại {page_ref.file_path}")

                source_pages_bgr.append(src_bgr)

                # Sinh text-stroke mask (không lấy cả bbox hình chữ nhật)
                # Chuyển đổi segments sang format MangaSegmentItem
                mask = generate_text_stroke_mask(src_bgr, page_trans.segments)
                inpaint_masks.append(mask)

                # Thực thi inpaint
                inpainted_bgr = self.inpainter.inpaint(src_bgr, mask)
                inpainted_pages_bgr.append(inpainted_bgr)

            # 5. TYPESETTING: Dàn trang chữ tiếng Việt với dynamic fitting và centering
            await self.coordinator.transition_stage(
                stage="TYPESETTING",
                progress=85,
                message="Typesetting Vietnamese text with dynamic fitting and outline stroke",
            )

            final_rendered_pages_bgr: List[cv2.Mat] = []
            typeset_masks: List[cv2.Mat] = []

            for page_idx, page_trans in enumerate(translation_result.pages):
                inpainted_bgr = inpainted_pages_bgr[page_idx]
                rendered_bgr, t_mask = self.typesetter.render_page(
                    image_bgr=inpainted_bgr,
                    segments=page_trans.segments,
                )
                final_rendered_pages_bgr.append(rendered_bgr)
                typeset_masks.append(t_mask)

            # 6. QUALITY_CHECK: Kiểm định chất lượng hình học, pixel invariance và nén WebP
            await self.coordinator.transition_stage(
                stage="QUALITY_CHECK",
                progress=95,
                message="Executing mechanical visual QA and WebP compression",
            )

            encoded_webp_pages: List[bytes] = []
            for page_idx, rendered_bgr in enumerate(final_rendered_pages_bgr):
                src_bgr = source_pages_bgr[page_idx]
                src_h, src_w = src_bgr.shape[:2]

                # Geometry check
                self.qa.verify_page_geometry(source_w=src_w, source_h=src_h, output_bgr=rendered_bgr)

                # Pixel Invariance check: Pixel ngoài (inpaint_mask ∪ typeset_mask) nguyên vẹn 100%
                self.qa.verify_pixel_invariance(
                    source_bgr=src_bgr,
                    final_bgr=rendered_bgr,
                    inpaint_mask=inpaint_masks[page_idx],
                    typeset_mask=typeset_masks[page_idx],
                )

                # Nén sang WebP lossless / quality 90
                encode_success, webp_buf = cv2.imencode(
                    ".webp", rendered_bgr, [cv2.IMWRITE_WEBP_QUALITY, 90]
                )
                if not encode_success or webp_buf is None:
                    raise ValueError(f"Nén WebP thất bại cho trang {page_idx + 1}")

                webp_bytes = webp_buf.tobytes()
                self.qa.verify_webp_encoding(webp_bytes, expected_w=src_w, expected_h=src_h)
                encoded_webp_pages.append(webp_bytes)

            # 7. TWO-STEP UPLOAD & MANIFEST ASSEMBLY
            output_filenames = [f"page_{idx + 1:04d}.webp" for idx in range(len(encoded_webp_pages))]

            if self.request_upload_urls is not None and self.upload_file is not None:
                # 1. Xin Core API cấp canonical presigned URLs
                upload_slots = await self.request_upload_urls(job_id, attempt_number, output_filenames)
                if len(upload_slots) != len(encoded_webp_pages):
                    raise ValueError("Core API cấp không đủ số lượng upload URLs cho các trang")

                manifest_pages = []
                for idx, slot in enumerate(upload_slots):
                    webp_data = encoded_webp_pages[idx]
                    src_h, src_w = source_pages_bgr[idx].shape[:2]

                    # Upload lên MinIO qua presigned URL
                    await self.upload_file(slot["uploadUrl"], webp_data, "image/webp")

                    # Invariant: Dùng canonical storageKey do Core trả về
                    manifest_pages.append(
                        {
                            "page": idx + 1,
                            "storageKey": slot["storageKey"],
                            "previewKey": slot["storageKey"],
                            "width": src_w,
                            "height": src_h,
                            "fileSize": len(webp_data),
                        }
                    )
            else:
                # Mock storage keys cho local unit testing
                manifest_pages = [
                    {
                        "page": idx + 1,
                        "storageKey": f"ai/jobs/{job_id}/attempt-{attempt_number}/page_{idx + 1:04d}.webp",
                        "previewKey": f"ai/jobs/{job_id}/attempt-{attempt_number}/page_{idx + 1:04d}.webp",
                        "width": source_pages_bgr[idx].shape[1],
                        "height": source_pages_bgr[idx].shape[0],
                        "fileSize": len(encoded_webp_pages[idx]),
                    }
                    for idx in range(len(encoded_webp_pages))
                ]

            result_manifest = {"pages": manifest_pages}

            # 8. TẬP HỢP FINAL SEGMENTS VÀ PHÁT CALLBACK READY_FOR_REVIEW
            final_segments_payload = [
                {
                    "pageNumber": s.page_number,
                    "sortOrder": s.sort_order,
                    "bboxX": s.bbox_x,
                    "bboxY": s.bbox_y,
                    "bboxW": s.bbox_w,
                    "bboxH": s.bbox_h,
                    "rawText": s.raw_text,
                    "translatedText": s.translated_text,
                    "confidence": s.confidence,
                }
                for p in translation_result.pages
                for s in p.segments
            ]

            await self.coordinator.emit_ready(
                result_manifest=result_manifest,
                segments=final_segments_payload,
            )

            return {
                "success": True,
                "jobId": job_id,
                "attemptNumber": attempt_number,
                "status": "READY_FOR_REVIEW",
                "pagesProcessed": len(manifest_pages),
                "segmentsCount": len(final_segments_payload),
            }

        finally:
            await self.coordinator.stop()
            # Dọn dẹp an toàn thư mục tạm
            if work_dir.exists():
                shutil.rmtree(work_dir, ignore_errors=True)
