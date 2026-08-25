import cv2
import numpy as np
import pytest

from app.qa.visual_qa import VisualQAEvaluator, VisualQAError


def test_verify_page_geometry():
    evaluator = VisualQAEvaluator()
    img = np.zeros((600, 400, 3), dtype=np.uint8)

    # Khớp kích thước
    evaluator.verify_page_geometry(400, 600, img)

    # Sai kích thước
    with pytest.raises(VisualQAError, match="PAGE_GEOMETRY_MISMATCH"):
        evaluator.verify_page_geometry(500, 600, img)


def test_verify_pixel_invariance():
    evaluator = VisualQAEvaluator()

    source = np.full((300, 300, 3), 100, dtype=np.uint8)
    final_img = source.copy()

    inpaint_mask = np.zeros((300, 300), dtype=np.uint8)
    typeset_mask = np.zeros((300, 300), dtype=np.uint8)

    # Thay đổi trong vùng inpaint mask
    inpaint_mask[50:100, 50:100] = 255
    final_img[50:100, 50:100] = 200

    # Thay đổi trong vùng typeset mask
    typeset_mask[120:180, 120:180] = 255
    final_img[120:180, 120:180] = 0

    # 1. Hợp lệ: Pixel ngoài (inpaint_mask | typeset_mask) không đổi
    evaluator.verify_pixel_invariance(source, final_img, inpaint_mask, typeset_mask)

    # 2. Bất hợp lệ: Có 1 pixel tại (10, 10) bị đổi ngoài vùng cho phép
    corrupted_img = final_img.copy()
    corrupted_img[10, 10] = (255, 0, 0)

    with pytest.raises(VisualQAError, match="PIXEL_INVARIANCE_VIOLATION"):
        evaluator.verify_pixel_invariance(source, corrupted_img, inpaint_mask, typeset_mask)


def test_verify_webp_encoding_and_manifest():
    evaluator = VisualQAEvaluator()
    img = np.zeros((400, 300, 3), dtype=np.uint8)

    _, webp_buf = cv2.imencode(".webp", img)
    webp_bytes = webp_buf.tobytes()

    evaluator.verify_webp_encoding(webp_bytes, expected_w=300, expected_h=400)

    # Manifest completeness
    manifest_pages = [
        {"page": 1, "storageKey": "k1"},
        {"page": 2, "storageKey": "k2"},
    ]
    evaluator.verify_manifest_completeness(
        source_page_count=2,
        manifest_pages=manifest_pages,
        expected_segment_keys={"p0001-s0001", "p0002-s0001"},
        output_segment_keys={"p0001-s0001", "p0002-s0001"},
    )
