import hashlib
import io
import logging
from typing import Dict, List, Optional
import cv2
import httpx
import numpy as np
from PIL import Image
from fastapi import HTTPException, status

from app.core.config import settings
from app.core.ssrf_safe_downloader import safe_download_bytes, validate_download_url
from app.models.materialize import (
    MaterializeMangaRequest,
    MaterializationSnapshotV1,
)
from app.translation.manga_translator import MangaTranslatedSegmentResult
from app.typesetting.typesetter import MangaTypesetter

logger = logging.getLogger(__name__)


class MangaReRenderer:
    """
    Engine re-render Manga text tiếng Việt lên clean base:
    - Zero OCR / Zero LLM
    - Typesets segments onto clean bases
    - Lossless WebP output
    """

    def __init__(self, typesetter: Optional[MangaTypesetter] = None):
        self.typesetter = typesetter or MangaTypesetter()

    async def re_render_manga(self, request: MaterializeMangaRequest) -> None:
        """
        Thực hiện re-render Manga:
        1. Tải & thẩm định SHA-256 snapshot trước khi parse
        2. Validate snapshot invariants
        3. Iterate pages, render text, upload lossless WebP
        4. Callback về Core API
        """
        # 1. Tải snapshot qua SSRF-safe downloader
        raw_snapshot = await safe_download_bytes(request.snapshot_url)

        # 2. Verify Content-Addressed SHA-256
        actual_sha256 = hashlib.sha256(raw_snapshot).hexdigest()
        if actual_sha256 != request.snapshot_sha256:
            logger.error(
                f"[MangaReRenderer] SHA-256 mismatch cho job {request.job_id}: "
                f"expected {request.snapshot_sha256}, actual {actual_sha256}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"SNAPSHOT_HASH_MISMATCH: expected {request.snapshot_sha256}, got {actual_sha256}",
            )

        # 3. Parse Strict Snapshot V1
        try:
            snapshot = MaterializationSnapshotV1.model_validate_json(raw_snapshot)
        except Exception as e:
            logger.error(f"[MangaReRenderer] Lỗi parse snapshot V1: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"INVALID_SNAPSHOT_PAYLOAD: {str(e)}",
            )

        # 4. Thẩm định Snapshot Invariants
        if (
            snapshot.jobId != request.job_id
            or snapshot.targetRevision != request.target_revision
            or snapshot.mediaFormat != "COMIC"
        ):
            logger.error(
                f"[MangaReRenderer] Snapshot invariants mismatch cho job {request.job_id}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="SNAPSHOT_INVARIANT_MISMATCH: snapshot metadata does not match request",
            )

        # 5. Group segments theo pageNumber
        segments_by_page: Dict[int, List] = {}
        for seg in snapshot.segments:
            if seg.pageNumber is not None:
                segments_by_page.setdefault(seg.pageNumber, []).append(seg)

        # 6. Sắp xếp các trang theo thứ tự 1..N
        sorted_page_slots = sorted(request.pages, key=lambda p: p.page_number)
        completed_pages = []

        transport_limits = httpx.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0)
        async with httpx.AsyncClient(timeout=transport_limits, follow_redirects=False) as http_client:
            for slot in sorted_page_slots:
                # Tải clean base qua SSRF-safe downloader
                clean_base_bytes = await safe_download_bytes(slot.clean_base_url)
                clean_bgr = cv2.imdecode(
                    np.frombuffer(clean_base_bytes, np.uint8), cv2.IMREAD_COLOR
                )
                if clean_bgr is None:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=f"Không thể giải mã ảnh clean base cho trang {slot.page_number}",
                    )

                # Lấy danh sách segments của trang
                page_segs = segments_by_page.get(slot.page_number, [])
                page_segs.sort(key=lambda s: s.sortOrder)

                # Segment Adapter: chuyển đổi sang MangaTranslatedSegmentResult với tọa độ làm tròn int
                adapted_segments = [
                    MangaTranslatedSegmentResult(
                        page_number=s.pageNumber,
                        sort_order=s.sortOrder,
                        bbox_x=int(round(float(s.bboxX))),
                        bbox_y=int(round(float(s.bboxY))),
                        bbox_w=int(round(float(s.bboxW))),
                        bbox_h=int(round(float(s.bboxH))),
                        raw_text=s.rawText,
                        translated_text=s.translatedText,
                    )
                    for s in page_segs
                ]

                # Re-render chữ lên clean base (Zero OCR / Zero LLM)
                if adapted_segments:
                    rendered_bgr, _ = self.typesetter.render_page(clean_bgr, adapted_segments)
                else:
                    # Trang không có segment: giữ nguyên clean base
                    rendered_bgr = clean_bgr

                # Mã hóa WebP lossless qua Pillow
                h, w = rendered_bgr.shape[:2]
                img_rgb = cv2.cvtColor(rendered_bgr, cv2.COLOR_BGR2RGB)
                pil_img = Image.fromarray(img_rgb)
                buf = io.BytesIO()
                pil_img.save(buf, format="WEBP", lossless=True)
                webp_bytes = buf.getvalue()

                # Thẩm định an toàn SSRF trên output upload url trước khi PUT
                validate_download_url(slot.output_upload_url)

                # Upload WebP qua HTTP PUT
                upload_resp = await http_client.put(
                    slot.output_upload_url,
                    content=webp_bytes,
                    headers={"Content-Type": "image/webp"},
                )
                if upload_resp.status_code not in (200, 204):
                    logger.error(
                        f"[MangaReRenderer] Upload trang {slot.page_number} thất bại với HTTP {upload_resp.status_code}"
                    )
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=f"Upload output artifact trang {slot.page_number} thất bại: HTTP {upload_resp.status_code}",
                    )

                completed_pages.append({
                    "page": slot.page_number,
                    "storageKey": slot.storage_key,
                    "previewKey": slot.storage_key,
                    "width": w,
                    "height": h,
                    "fileSizeBytes": len(webp_bytes),
                })

            # 7. Gửi Completion Callback về Core API qua settings.CORE_API_INTERNAL_URL canonical
            callback_url = (
                f"{settings.CORE_API_INTERNAL_URL}"
                f"/internal/v1/ai/jobs/{request.job_id}/materializations/complete"
            )
            callback_payload = {
                "targetRevision": request.target_revision,
                "mediaFormat": "COMIC",
                "result": {
                    "version": 1,
                    "mediaFormat": "COMIC",
                    "pages": completed_pages,
                },
            }

            cb_resp = await http_client.post(
                callback_url,
                json=callback_payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
                },
            )
            if not cb_resp.is_success:
                logger.error(
                    f"[MangaReRenderer] Callback Core API thất bại với HTTP {cb_resp.status_code}: {cb_resp.text}"
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Callback Core API thất bại với HTTP {cb_resp.status_code}: {cb_resp.text}",
                )

        logger.info(
            f"[MangaReRenderer] Materialization hoàn tất thành công cho job {request.job_id} rev {request.target_revision}"
        )

