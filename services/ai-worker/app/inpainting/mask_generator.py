from typing import List, Sequence
import cv2
import numpy as np
from app.translation.context_builder import MangaSegmentItem

MAX_MASK_COVERAGE_DEFAULT = 0.65


class MaskCoverageExceededError(ValueError):
    """Ném ra khi tỷ lệ diện tích mask vượt quá giới hạn an toàn (>65% ROI)."""
    pass


def generate_text_stroke_mask(
    image_bgr: np.ndarray,
    segments: Sequence[MangaSegmentItem],
    max_coverage: float = MAX_MASK_COVERAGE_DEFAULT,
    dilate_kernel_size: int = 3,
) -> np.ndarray:
    """
    Sinh binary mask chính xác bám theo nét chữ (text-stroke mask), không inpaint toàn bộ rectangle bbox:
    1. Chỉ quét bên trong vùng ROI của từng OCR segment.
    2. Áp dụng Otsu thresholding / Morphological gradient để trích xuất glyph strokes thực tế.
    3. Dilation nhẹ (1-3px) để phủ viền răng cưa khử nét của chữ gốc.
    4. Safety guard: Assert mask_pixels / ROI_pixels <= max_coverage (65%).
    5. Mask ngoài ROI = 0 (nền đen).
    """
    img_h, img_w = image_bgr.shape[:2]
    full_mask = np.zeros((img_h, img_w), dtype=np.uint8)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_kernel_size, dilate_kernel_size))

    for seg in segments:
        x1 = max(0, min(seg.bbox_x, img_w - 1))
        y1 = max(0, min(seg.bbox_y, img_h - 1))
        x2 = max(0, min(seg.bbox_x + seg.bbox_w, img_w))
        y2 = max(0, min(seg.bbox_y + seg.bbox_h, img_h))

        roi_w = x2 - x1
        roi_h = y2 - y1
        if roi_w <= 0 or roi_h <= 0:
            continue

        roi = image_bgr[y1:y2, x1:x2]
        roi_gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        # 1. Phát hiện màu nền của bubble: Lấy trung bình viền biên ROI
        border_pixels = np.concatenate([
            roi_gray[0, :], roi_gray[-1, :],
            roi_gray[:, 0], roi_gray[:, -1]
        ])
        border_mean = np.mean(border_pixels)

        # 2. Phân tách nét chữ theo Otsu
        if border_mean > 127:
            # Nền sáng chữ tối (phổ biến nhất trong manga): chữ có pixel tối hơn nền
            _, stroke_mask = cv2.threshold(roi_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        else:
            # Nền tối chữ sáng
            _, stroke_mask = cv2.threshold(roi_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        # 3. Dilation nhẹ bọc lấy viền nét chữ
        stroke_mask = cv2.dilate(stroke_mask, kernel, iterations=1)

        # 4. Safety Guard: Kiểm tra độ che phủ mask
        roi_total_pixels = roi_w * roi_h
        mask_active_pixels = int(np.count_nonzero(stroke_mask))
        coverage = mask_active_pixels / float(roi_total_pixels)

        if coverage > max_coverage:
            raise MaskCoverageExceededError(
                f"MASK_COVERAGE_EXCEEDED: Segment {seg.segment_key} mask coverage {coverage:.2%} "
                f"vượt quá ngưỡng an toàn {max_coverage:.2%}. Dừng inpaint để tránh xóa tranh."
            )

        full_mask[y1:y2, x1:x2] = np.maximum(full_mask[y1:y2, x1:x2], stroke_mask)

    return full_mask
