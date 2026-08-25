import cv2
import numpy as np
import pytest

from app.inpainting.inpainter import MangaInpainter
from app.inpainting.mask_generator import (
    MaskCoverageExceededError,
    generate_text_stroke_mask,
)
from app.translation.context_builder import MangaSegmentItem


def _create_sample_manga_page() -> np.ndarray:
    """Tạo ảnh manga giả lập: nền xám có screentone, bubble trắng và chữ đen bên trong."""
    img = np.full((400, 300, 3), 180, dtype=np.uint8)  # Nền screentone xám

    # Vẽ bubble trắng hình ellipse
    cv2.ellipse(img, (150, 200), (80, 100), 0, 0, 360, (255, 255, 255), -1)
    cv2.ellipse(img, (150, 200), (80, 100), 0, 0, 360, (0, 0, 0), 2)  # Viền đen bubble

    # Vẽ chữ đen bên trong bubble
    cv2.putText(img, "HELLO", (110, 190), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    cv2.putText(img, "WORLD", (110, 220), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    return img


def test_text_stroke_mask_does_not_mask_entire_rectangle():
    img = _create_sample_manga_page()
    seg = MangaSegmentItem(
        page_number=1,
        sort_order=1,
        bbox_x=100,
        bbox_y=160,
        bbox_w=100,
        bbox_h=80,
        raw_text="HELLO WORLD",
    )

    mask = generate_text_stroke_mask(img, [seg], max_coverage=0.65)

    assert mask.shape == (400, 300)
    # Mask phải có pixel hoạt động ở vùng chữ
    active_pixels = np.count_nonzero(mask)
    assert active_pixels > 50

    # Invariant: Mask KHÔNG ĐƯỢC phủ kín cả hình chữ nhật 100x80 (8000 pixels)
    roi_area = 100 * 80
    assert active_pixels < roi_area * 0.50  # Chữ chỉ chiếm khoảng 10-35% diện tích ROI

    # Pixel ngoài ROI bắt buộc bằng 0
    outside_roi = mask.copy()
    outside_roi[160:240, 100:200] = 0
    assert np.count_nonzero(outside_roi) == 0


def test_mask_coverage_exceeded_guard():
    # Tạo ảnh trắng có vùng đen lớn bên trong ROI để vượt quá 65% coverage
    img = np.full((200, 200, 3), 255, dtype=np.uint8)
    img[12:108, 12:108] = 0  # 96x96 pixels đen trong khung 100x100 (>90% coverage)

    seg = MangaSegmentItem(
        page_number=1,
        sort_order=1,
        bbox_x=10,
        bbox_y=10,
        bbox_w=100,
        bbox_h=100,
        raw_text="DENSE TEXT",
    )

    # Đặt max_coverage 0.65 để kích hoạt safety guard khi coverage ~90%
    with pytest.raises(MaskCoverageExceededError, match="MASK_COVERAGE_EXCEEDED"):
        generate_text_stroke_mask(img, [seg], max_coverage=0.65)


def test_inpainter_pixel_invariance_outside_mask():
    img = _create_sample_manga_page()
    seg = MangaSegmentItem(
        page_number=1,
        sort_order=1,
        bbox_x=100,
        bbox_y=160,
        bbox_w=100,
        bbox_h=80,
        raw_text="HELLO WORLD",
    )

    mask = generate_text_stroke_mask(img, [seg])
    inpainter = MangaInpainter()
    inpainted = inpainter.inpaint(img, mask)

    assert inpainted.shape == img.shape

    # Invariant: Mọi pixel ở vùng mask == 0 phải nguyên vẹn 100% như ảnh gốc
    unmodified_mask = (mask == 0)
    assert np.array_equal(img[unmodified_mask], inpainted[unmodified_mask])

    # Ở vùng chữ (mask == 255), chữ đen đã được thay thế bằng màu nền trắng của bubble
    text_region = inpainted[180:200, 110:190]
    assert np.mean(text_region) > 200  # Đã chuyển sang nền trắng, không còn chữ đen (mean ~ 0)
