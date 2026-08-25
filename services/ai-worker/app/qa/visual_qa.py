from typing import Any, Dict, List, Sequence, Set
import cv2
import numpy as np
from PIL import Image
import io


class VisualQAError(ValueError):
    """Ném ra khi kiểm định chất lượng hình học / cơ học của trang truyện thất bại."""
    pass


class VisualQAEvaluator:
    """
    Bộ thẩm định chất lượng hình học và độ toàn vẹn ảnh xuất xưởng (Mechanical Visual QA):
    - Đảm bảo 1:1 kích thước ảnh gốc và ảnh sau xử lý.
    - Pixel Invariance: Pixel bên ngoài vùng (inpaint_mask ∪ typeset_mask) bất biến tuyệt đối 100%.
    - Thẩm định giải mã WebP đầu ra.
    - Thẩm định số trang, thứ tự trang và tập hợp segmentKey 1:1.
    """

    @staticmethod
    def verify_page_geometry(
        source_w: int,
        source_h: int,
        output_bgr: np.ndarray,
    ) -> None:
        """Kiểm tra kích thước và dữ liệu ma trận ảnh xuất xưởng."""
        if output_bgr is None or output_bgr.size == 0:
            raise VisualQAError("VISUAL_QA_FAILED: Ma trận ảnh đầu ra rỗng (None hoặc size=0).")

        out_h, out_w = output_bgr.shape[:2]
        if out_w != source_w or out_h != source_h:
            raise VisualQAError(
                f"PAGE_GEOMETRY_MISMATCH: Kích thước ảnh xuất ({out_w}x{out_h}) "
                f"không khớp kích thước ảnh gốc ({source_w}x{source_h})."
            )

    @staticmethod
    def verify_pixel_invariance(
        source_bgr: np.ndarray,
        final_bgr: np.ndarray,
        inpaint_mask: np.ndarray,
        typeset_mask: np.ndarray,
    ) -> None:
        """
        Kiểm tra tính bất biến của pixel ngoài vùng cho phép:
        allowed_change_region = (inpaint_mask > 0) ∪ (typeset_mask > 0).
        Mọi pixel nằm ngoài union này BẮT BUỘC phải nguyên vẹn như ảnh gốc.
        """
        allowed_change = (inpaint_mask > 0) | (typeset_mask > 0)
        outside_allowed = ~allowed_change

        if not np.array_equal(source_bgr[outside_allowed], final_bgr[outside_allowed]):
            diff = np.abs(source_bgr[outside_allowed].astype(np.int32) - final_bgr[outside_allowed].astype(np.int32))
            max_diff = np.max(diff)
            mismatch_pixels = int(np.count_nonzero(diff > 0)) // 3
            raise VisualQAError(
                f"PIXEL_INVARIANCE_VIOLATION: Phát hiện {mismatch_pixels} pixels bị thay đổi "
                f"bên ngoài vùng allowed_change_region (max diff: {max_diff})."
            )

    @staticmethod
    def verify_webp_encoding(
        webp_bytes: bytes,
        expected_w: int,
        expected_h: int,
        max_bytes: int = 15 * 1024 * 1024,
    ) -> None:
        """Kiểm tra tính toàn vẹn của tệp WebP sau nén."""
        if not webp_bytes or len(webp_bytes) == 0:
            raise VisualQAError("WEBP_EMPTY: Dữ liệu buffer WebP bị rỗng.")

        if len(webp_bytes) > max_bytes:
            raise VisualQAError(
                f"WEBP_OVERSIZED: Dung lượng WebP ({len(webp_bytes)} bytes) vượt quá giới hạn ({max_bytes} bytes)."
            )

        try:
            with Image.open(io.BytesIO(webp_bytes)) as im:
                im.verify()
            with Image.open(io.BytesIO(webp_bytes)) as im:
                if im.size != (expected_w, expected_h):
                    raise VisualQAError(
                        f"WEBP_DIMENSION_MISMATCH: Kích thước tệp WebP decode ({im.size}) "
                        f"không khớp kích thước kỳ vọng ({expected_w}, {expected_h})."
                    )
        except Exception as e:
            if isinstance(e, VisualQAError):
                raise
            raise VisualQAError(f"WEBP_DECODE_FAILED: Không thể decode file WebP: {str(e)}") from e

    @staticmethod
    def verify_manifest_completeness(
        source_page_count: int,
        manifest_pages: List[Dict[str, Any]],
        expected_segment_keys: Set[str],
        output_segment_keys: Set[str],
    ) -> None:
        """Kiểm tra tính đầy đủ và toàn vẹn của resultManifest."""
        if len(manifest_pages) != source_page_count:
            raise VisualQAError(
                f"PAGE_COUNT_MISMATCH: Số trang trong manifest ({len(manifest_pages)}) "
                f"không khớp số trang nguồn ({source_page_count})."
            )

        page_numbers = [p.get("page") for p in manifest_pages]
        expected_numbers = list(range(1, source_page_count + 1))
        if page_numbers != expected_numbers:
            raise VisualQAError(
                f"PAGE_SEQUENCE_CORRUPTED: Thứ tự trang {page_numbers} không khớp chuỗi tuần tự {expected_numbers}."
            )

        if expected_segment_keys != output_segment_keys:
            missing = expected_segment_keys - output_segment_keys
            extra = output_segment_keys - expected_segment_keys
            raise VisualQAError(
                f"SEGMENT_KEYS_CORRUPTED: Tập hợp segmentKey không khớp 1:1. "
                f"Thiếu: {missing}, Thừa: {extra}"
            )
