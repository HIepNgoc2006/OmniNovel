from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from app.pipeline.detector import MangaBubbleDetector


def test_detector_finds_bubbles(tmp_path: Path):
    # Tạo ảnh trắng 1000x1500 với 3 bong bóng thoại vẽ nét đen
    img = np.ones((1500, 1000, 3), dtype=np.uint8) * 255

    # Bong bóng 1: Góc trên phải (x=600, y=100, w=200, h=150)
    cv2.rectangle(img, (600, 100), (800, 250), (0, 0, 0), 3)
    cv2.putText(img, "TEST 1", (620, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)

    # Bong bóng 2: Góc trên trái (x=100, y=120, w=250, h=180)
    cv2.rectangle(img, (100, 120), (350, 300), (0, 0, 0), 3)
    cv2.putText(img, "TEST 2", (120, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)

    # Bong bóng 3: Góc dưới (x=300, y=800, w=400, h=200)
    cv2.rectangle(img, (300, 800), (700, 1000), (0, 0, 0), 3)
    cv2.putText(img, "TEST 3", (350, 900), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)

    test_img_path = tmp_path / "page.png"
    cv2.imwrite(str(test_img_path), img)

    detector = MangaBubbleDetector(min_area=500, min_dim=20)
    regions = detector.detect_regions(test_img_path)

    assert len(regions) >= 3

    # Kiểm tra invariants: Tọa độ là INT không âm
    for r in regions:
        assert isinstance(r.bbox_x, int) and r.bbox_x >= 0
        assert isinstance(r.bbox_y, int) and r.bbox_y >= 0
        assert isinstance(r.bbox_w, int) and r.bbox_w > 0
        assert isinstance(r.bbox_h, int) and r.bbox_h > 0
        assert r.bbox_x + r.bbox_w <= 1000
        assert r.bbox_y + r.bbox_h <= 1500


def test_detector_detects_vertical_text_bubble(tmp_path: Path):
    # Tạo trang Manga chứa bong bóng thoại dọc chuẩn Manga Nhật (Vertical layout)
    pil_img = Image.new("RGB", (800, 1200), (255, 255, 255))
    draw = ImageDraw.Draw(pil_img)

    # Khung thoại dọc: x=550, y=100, w=150, h=400
    draw.ellipse([(550, 100), (700, 500)], outline=(0, 0, 0), width=3)

    # Vẽ chuỗi ký tự dọc dạng nét
    for y_offset in range(150, 450, 60):
        draw.rectangle([(610, y_offset), (640, y_offset + 40)], fill=(0, 0, 0))

    test_img_path = tmp_path / "vertical_page.png"
    pil_img.save(test_img_path)

    detector = MangaBubbleDetector(min_area=500, min_dim=20)
    regions = detector.detect_regions(test_img_path)

    assert len(regions) >= 1
    vert_region = [r for r in regions if r.bbox_x >= 500 and r.bbox_y >= 80][0]
    assert vert_region.bbox_h > vert_region.bbox_w  # Chiều cao lớn hơn chiều rộng (dọc)
    assert vert_region.bbox_x >= 0 and vert_region.bbox_y >= 0


def test_detector_handles_blank_image(tmp_path: Path):
    # Ảnh hoàn toàn trắng
    img = np.ones((1000, 800, 3), dtype=np.uint8) * 255
    test_img_path = tmp_path / "blank.png"
    cv2.imwrite(str(test_img_path), img)

    detector = MangaBubbleDetector()
    regions = detector.detect_regions(test_img_path)

    assert len(regions) == 0
