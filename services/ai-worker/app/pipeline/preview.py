from dataclasses import dataclass
from pathlib import Path
from typing import List
import cv2
import numpy as np
from app.pipeline.detector import DetectedRegion


@dataclass(frozen=True)
class SegmentPreviewItem:
    sort_order: int
    region: DetectedRegion


def generate_ocr_debug_preview(
    source_image_path: Path,
    segments: List[SegmentPreviewItem],
    output_webp_path: Path,
) -> Path:
    """
    Vẽ OCR Debug Preview ảnh WebP:
    - Vẽ bounding box hình chữ nhật tại các tọa độ PIXEL của bubble/text region.
    - Vẽ badge đánh số thứ tự đọc (#1, #2, ...) bằng Hershey font tiêu chuẩn của OpenCV.
    - Không render ký tự tiếng Nhật nhằm tránh phụ thuộc font hệ điều hành.
    """
    data = np.fromfile(str(source_image_path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Failed to read image from {source_image_path}")

    # Màu sắc viền: Cyan / Emerald rực rỡ (BGR: 255, 200, 0)
    box_color = (255, 200, 0)
    badge_bg = (0, 0, 180)  # Đỏ trầm
    badge_text_color = (255, 255, 255)  # Trắng

    for item in segments:
        r = item.region
        x, y, w, h = r.bbox_x, r.bbox_y, r.bbox_w, r.bbox_h

        # 1. Vẽ bounding box
        cv2.rectangle(img, (x, y), (x + w, y + h), box_color, 2)

        # 2. Vẽ badge số thứ tự
        label = f"#{item.sort_order}"
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.6
        font_thickness = 2

        (text_w, text_h), baseline = cv2.getTextSize(label, font, font_scale, font_thickness)
        badge_x = x
        badge_y = max(0, y - text_h - baseline - 4)

        # Vẽ nền badge
        cv2.rectangle(
            img,
            (badge_x, badge_y),
            (badge_x + text_w + 8, badge_y + text_h + baseline + 4),
            badge_bg,
            -1,
        )

        # Vẽ chữ label
        cv2.putText(
            img,
            label,
            (badge_x + 4, badge_y + text_h + 2),
            font,
            font_scale,
            badge_text_color,
            font_thickness,
            cv2.LINE_AA,
        )

    output_webp_path.parent.mkdir(parents=True, exist_ok=True)
    success, encoded = cv2.imencode(".webp", img, [cv2.IMWRITE_WEBP_QUALITY, 90])
    if not success:
        raise RuntimeError(f"Failed to encode preview WebP to {output_webp_path}")

    encoded.tofile(str(output_webp_path))
    return output_webp_path
