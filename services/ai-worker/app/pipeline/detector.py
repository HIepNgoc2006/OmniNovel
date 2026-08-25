from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple
import cv2
import numpy as np


@dataclass(frozen=True)
class DetectedRegion:
    bbox_x: int  # Pixel X (>= 0)
    bbox_y: int  # Pixel Y (>= 0)
    bbox_w: int  # Pixel Width (> 0)
    bbox_h: int  # Pixel Height (> 0)


def _read_image_safely(image_path: Path) -> np.ndarray:
    """Đọc ảnh an toàn trên Windows hỗ trợ unicode path."""
    data = np.fromfile(str(image_path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Failed to decode image from {image_path}")
    return img


def _boxes_intersect(b1: Tuple[int, int, int, int], b2: Tuple[int, int, int, int]) -> bool:
    x1, y1, w1, h1 = b1
    x2, y2, w2, h2 = b2
    return not (x1 + w1 < x2 or x2 + w2 < x1 or y1 + h1 < y2 or y2 + h2 < y1)


def _merge_overlapping_boxes(boxes: List[Tuple[int, int, int, int]]) -> List[Tuple[int, int, int, int]]:
    """Gộp các bounding box giao nhau hoặc lồng nhau."""
    if not boxes:
        return []

    merged = list(boxes)
    has_merged = True

    while has_merged:
        has_merged = False
        new_merged = []
        skip_indices = set()

        for i in range(len(merged)):
            if i in skip_indices:
                continue
            curr = merged[i]
            for j in range(i + 1, len(merged)):
                if j in skip_indices:
                    continue
                other = merged[j]
                if _boxes_intersect(curr, other):
                    # Gộp thành bounding box bao cả 2
                    x = min(curr[0], other[0])
                    y = min(curr[1], other[1])
                    w = max(curr[0] + curr[2], other[0] + other[2]) - x
                    h = max(curr[1] + curr[3], other[1] + other[3]) - y
                    curr = (x, y, w, h)
                    skip_indices.add(j)
                    has_merged = True
            new_merged.append(curr)

        merged = new_merged

    return merged


class MangaBubbleDetector:
    """
    Detector phát hiện vùng thoại / chữ (Speech Bubbles & Text Regions) sử dụng OpenCV Morphology:
    - Binarization & Adaptive Thresholding
    - Morphological Closing & Dilation gom nhóm ký tự tiếng Nhật (dọc/ngang)
    - Lọc kích thước tối thiểu, diện tích và loại trừ khung tranh toàn trang
    - Tọa độ trả về là hệ PIXEL tuyệt đối (INT >= 0)
    """

    def __init__(self, min_area: int = 400, min_dim: int = 15):
        self.min_area = min_area
        self.min_dim = min_dim

    def detect_regions(self, image_path: Path) -> List[DetectedRegion]:
        img = _read_image_safely(image_path)
        img_h, img_w = img.shape[:2]
        page_area = img_w * img_h

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # 1. Edge-preserving smoothing + Thresholding
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

        # 2. Morphological operations để kết nối các nét chữ rời rạc
        kernel_vert = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 15))
        kernel_horiz = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 5))
        
        dilated_v = cv2.dilate(thresh, kernel_vert, iterations=2)
        dilated_h = cv2.dilate(thresh, kernel_horiz, iterations=2)
        combined = cv2.bitwise_or(dilated_v, dilated_h)

        kernel_close = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
        closed = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel_close, iterations=2)

        # 3. Tìm contours
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        candidate_boxes: List[Tuple[int, int, int, int]] = []

        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            area = w * h

            # Lọc nhiễu nhỏ
            if area < self.min_area or w < self.min_dim or h < self.min_dim:
                continue

            # Lọc viền bao toàn trang (> 95% diện tích trang)
            if area > 0.95 * page_area:
                continue

            # Bounding box hợp lệ -> Clamp vào biên trang
            x = max(0, min(x, img_w - 1))
            y = max(0, min(y, img_h - 1))
            w = max(1, min(w, img_w - x))
            h = max(1, min(h, img_h - y))

            candidate_boxes.append((x, y, w, h))

        # 4. Gộp các box chồng lấn
        merged_boxes = _merge_overlapping_boxes(candidate_boxes)

        return [
            DetectedRegion(
                bbox_x=int(b[0]),
                bbox_y=int(b[1]),
                bbox_w=int(b[2]),
                bbox_h=int(b[3]),
            )
            for b in merged_boxes
        ]
