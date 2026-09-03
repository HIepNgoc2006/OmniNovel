import asyncio
import io
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set
import cv2
import numpy as np
from PIL import Image

from app.core.config import settings
from app.core.package_extractor import ExtractedPageRef, extract_chapter_package
from app.core.ssrf_safe_downloader import safe_download_archive
from app.inpainting.inpainter import MangaInpainter
from app.inpainting.mask_generator import generate_text_stroke_mask
from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
from app.pipeline.manga_pipeline import MangaOcrPipeline, MangaOcrResult
from app.qa.visual_qa import VisualQAEvaluator
from app.translation.manga_translator import MangaTranslationPipeline, MangaTranslationResult
from app.typesetting.typesetter import MangaTypesetter


class FullMangaPipeline:
    """
    Orchestration trọn vẹn của quy trình sản xuất Manga (Vertical Slice 2C Hardened):
    1. Bounded SSRF download & Non-blocking ZIP extraction (PREPROCESSING - 10%)
    2. Bubble Detection & Japanese Manga-OCR (OCR - 30%)
    3. Contextual Translation & Glossary Constraints (TRANSLATING - 50%)
    4. Pass 1: Text-Stroke Mask Generation & Inpainting (INPAINTING - 70% - Spill-to-Disk)
    5. Pass 2: Vietnamese Typography Rendering (TYPESETTING - 85% - Spill-to-Disk)
    6. Pass 3: Lossless WebP Compression & Post-Decode Invariance QA (QUALITY_CHECK - 95%)
    7. Two-Step Presigned Upload & Strict Manifest Verification (100%)
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
        inpaint_dir = work_dir / "inpainted"
        mask_dir = work_dir / "masks"
        typeset_dir = work_dir / "typeset"
        rendered_dir = work_dir / "rendered_webp"

        inpaint_dir.mkdir(parents=True, exist_ok=True)
        mask_dir.mkdir(parents=True, exist_ok=True)
        typeset_dir.mkdir(parents=True, exist_ok=True)
        rendered_dir.mkdir(parents=True, exist_ok=True)

        # Bắt đầu background heartbeat loop đồng bộ
        self.coordinator.start()

        try:
            # 1. PREPROCESSING: Tải an toàn và giải nén source package non-blocking
            await self.coordinator.transition_stage(
                stage="PREPROCESSING",
                progress=10,
                message="Downloading and validating source package",
            )

            zip_target = work_dir / "source.zip"
            extracted_dir = work_dir / "extracted"

            await safe_download_archive(source_download_url, zip_target)
            extracted_pages: List[ExtractedPageRef] = await asyncio.to_thread(
                extract_chapter_package, zip_target, extracted_dir
            )

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

            # 4. PASS 1 — INPAINTING (Spill-to-Disk): Sinh text-stroke mask và inpaint xóa chữ gốc
            await self.coordinator.transition_stage(
                stage="INPAINTING",
                progress=70,
                message="Generating text-stroke masks and inpainting speech bubbles",
            )

            for page_idx, page_trans in enumerate(translation_result.pages):
                page_ref = extracted_pages[page_idx]
                src_bgr = cv2.imread(str(page_ref.file_path))
                if src_bgr is None:
                    raise ValueError(f"Không thể đọc file ảnh nguồn tại {page_ref.file_path}")

                mask = generate_text_stroke_mask(src_bgr, page_trans.segments)
                inpainted_bgr = self.inpainter.inpaint(src_bgr, mask)

                # Lưu intermediate outputs xuống disk để giải phóng RAM (O(1) Memory Footprint)
                cv2.imwrite(str(mask_dir / f"inpaint_mask_{page_idx + 1:04d}.png"), mask)
                cv2.imwrite(str(inpaint_dir / f"inpainted_{page_idx + 1:04d}.png"), inpainted_bgr)
                del src_bgr, mask, inpainted_bgr

            # 5. PASS 2 — TYPESETTING (Spill-to-Disk): Dàn chữ tiếng Việt với dynamic fitting
            await self.coordinator.transition_stage(
                stage="TYPESETTING",
                progress=85,
                message="Typesetting Vietnamese text with dynamic fitting and outline stroke",
            )

            for page_idx, page_trans in enumerate(translation_result.pages):
                inpainted_path = inpaint_dir / f"inpainted_{page_idx + 1:04d}.png"
                inpainted_bgr = cv2.imread(str(inpainted_path))
                if inpainted_bgr is None:
                    raise ValueError(f"Không thể đọc ảnh inpainted tại {inpainted_path}")

                rendered_bgr, t_mask = self.typesetter.render_page(
                    image_bgr=inpainted_bgr,
                    segments=page_trans.segments,
                )

                # Lưu rendered image và typeset mask xuống disk
                cv2.imwrite(str(typeset_dir / f"rendered_{page_idx + 1:04d}.png"), rendered_bgr)
                cv2.imwrite(str(mask_dir / f"typeset_mask_{page_idx + 1:04d}.png"), t_mask)
                del inpainted_bgr, rendered_bgr, t_mask

            # 6. PASS 3 — QUALITY_CHECK: Geometry, Lossless WebP Encode & Post-Decode Invariance QA
            await self.coordinator.transition_stage(
                stage="QUALITY_CHECK",
                progress=95,
                message="Executing mechanical visual QA and lossless WebP verification",
            )

            page_records: List[Dict[str, Any]] = []

            for page_idx in range(len(translation_result.pages)):
                page_ref = extracted_pages[page_idx]
                src_bgr = cv2.imread(str(page_ref.file_path))
                rendered_bgr = cv2.imread(str(typeset_dir / f"rendered_{page_idx + 1:04d}.png"))
                inpaint_mask = cv2.imread(str(mask_dir / f"inpaint_mask_{page_idx + 1:04d}.png"), cv2.IMREAD_GRAYSCALE)
                typeset_mask = cv2.imread(str(mask_dir / f"typeset_mask_{page_idx + 1:04d}.png"), cv2.IMREAD_GRAYSCALE)

                if src_bgr is None or rendered_bgr is None or inpaint_mask is None or typeset_mask is None:
                    raise ValueError(f"Không thể đọc đủ dữ liệu QA cho trang {page_idx + 1}")

                src_h, src_w = src_bgr.shape[:2]

                # Geometry check
                self.qa.verify_page_geometry(source_w=src_w, source_h=src_h, output_bgr=rendered_bgr)

                # Lossless WebP encoding
                pil_img = Image.fromarray(cv2.cvtColor(rendered_bgr, cv2.COLOR_BGR2RGB))
                buf = io.BytesIO()
                pil_img.save(buf, format="WEBP", lossless=True)
                webp_bytes = buf.getvalue()

                # Ghi WebP ra đĩa
                webp_path = rendered_dir / f"page_{page_idx + 1:04d}.webp"
                webp_path.write_bytes(webp_bytes)

                # POST-DECODE MECHANICAL QA: Thẩm định pixel invariance trên chính artifact WebP sau khi decode
                decoded_pil = Image.open(io.BytesIO(webp_bytes))
                decoded_bgr = cv2.cvtColor(np.array(decoded_pil), cv2.COLOR_RGB2BGR)

                self.qa.verify_pixel_invariance(
                    source_bgr=src_bgr,
                    final_bgr=decoded_bgr,
                    inpaint_mask=inpaint_mask,
                    typeset_mask=typeset_mask,
                )
                self.qa.verify_webp_encoding(webp_bytes, expected_w=src_w, expected_h=src_h)

                page_records.append(
                    {
                        "page": page_idx + 1,
                        "width": src_w,
                        "height": src_h,
                        "filePath": webp_path,
                        "fileSize": len(webp_bytes),
                    }
                )

                del src_bgr, rendered_bgr, inpaint_mask, typeset_mask, pil_img, decoded_pil, decoded_bgr, webp_bytes

            # 7. TWO-STEP PRESIGNED UPLOAD & MANIFEST ASSEMBLY
            output_filenames = [f"page_{p['page']:04d}.webp" for p in page_records]

            if self.request_upload_urls is not None and self.upload_file is not None:
                # 1. Xin Core API cấp canonical presigned URLs
                upload_slots = await self.request_upload_urls(job_id, attempt_number, output_filenames)
                if len(upload_slots) != len(page_records):
                    raise ValueError("Core API cấp không đủ số lượng upload URLs cho các trang")

                manifest_pages = []
                for idx, slot in enumerate(upload_slots):
                    prec = page_records[idx]
                    webp_data = prec["filePath"].read_bytes()

                    # Upload lên MinIO qua presigned URL
                    await self.upload_file(slot["uploadUrl"], webp_data, "image/webp")

                    # Invariant: Dùng canonical storageKey do Core trả về
                    manifest_pages.append(
                        {
                            "page": prec["page"],
                            "storageKey": slot["storageKey"],
                            "previewKey": slot["storageKey"],
                            "width": prec["width"],
                            "height": prec["height"],
                            "fileSizeBytes": prec["fileSize"],
                            "fileSize": prec["fileSize"],
                        }
                    )
            else:
                # Mock storage keys cho local unit testing
                manifest_pages = [
                    {
                        "page": prec["page"],
                        "storageKey": f"ai/jobs/{job_id}/attempt-{attempt_number}/page_{prec['page']:04d}.webp",
                        "previewKey": f"ai/jobs/{job_id}/attempt-{attempt_number}/page_{prec['page']:04d}.webp",
                        "width": prec["width"],
                        "height": prec["height"],
                        "fileSizeBytes": prec["fileSize"],
                        "fileSize": prec["fileSize"],
                    }
                    for prec in page_records
                ]

            # 8. MECHANICAL QA: Thẩm định tính đầy đủ và toàn vẹn của Manifest & Segment Keys 1:1
            expected_keys: Set[str] = {
                s.segment_key for p in ocr_result.pages for s in p.segments
            }
            output_keys: Set[str] = {
                s.segment_key for p in translation_result.pages for s in p.segments
            }
            self.qa.verify_manifest_completeness(
                source_page_count=len(extracted_pages),
                manifest_pages=manifest_pages,
                expected_segment_keys=expected_keys,
                output_segment_keys=output_keys,
            )

            result_manifest = {
                "version": 1,
                "mediaFormat": "COMIC",
                "pages": manifest_pages,
            }

            # 9. TẬP HỢP FINAL SEGMENTS VÀ PHÁT CALLBACK READY_FOR_REVIEW
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
