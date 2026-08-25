import random
from app.pipeline.detector import DetectedRegion
from app.pipeline.reading_order import sort_manga_reading_order


def test_sort_manga_reading_order_rtl_ttb():
    # Trang kích thước 1000 x 1500
    page_w = 1000
    page_h = 1500

    # Hàng 1 (Y ~ 100):
    r1_right = DetectedRegion(bbox_x=700, bbox_y=100, bbox_w=150, bbox_h=100)  # Thứ tự #1
    r1_left = DetectedRegion(bbox_x=200, bbox_y=120, bbox_w=150, bbox_h=100)   # Thứ tự #2

    # Hàng 2 (Y ~ 600):
    r2_right = DetectedRegion(bbox_x=650, bbox_y=600, bbox_w=200, bbox_h=120)  # Thứ tự #3
    r2_left = DetectedRegion(bbox_x=100, bbox_y=620, bbox_w=180, bbox_h=120)   # Thứ tự #4

    # Hàng 3 (Y ~ 1100):
    r3_center = DetectedRegion(bbox_x=400, bbox_y=1100, bbox_w=250, bbox_h=150) # Thứ tự #5

    input_regions = [r2_left, r3_center, r1_left, r2_right, r1_right]
    sorted_regions = sort_manga_reading_order(input_regions, page_w, page_h)

    assert len(sorted_regions) == 5
    assert sorted_regions[0] == r1_right
    assert sorted_regions[1] == r1_left
    assert sorted_regions[2] == r2_right
    assert sorted_regions[3] == r2_left
    assert sorted_regions[4] == r3_center


def test_sort_manga_reading_order_is_deterministic():
    page_w = 1200
    page_h = 1800

    regions = [
        DetectedRegion(bbox_x=800, bbox_y=50, bbox_w=100, bbox_h=100),
        DetectedRegion(bbox_x=300, bbox_y=60, bbox_w=120, bbox_h=100),
        DetectedRegion(bbox_x=900, bbox_y=700, bbox_w=100, bbox_h=100),
        DetectedRegion(bbox_x=200, bbox_y=720, bbox_w=150, bbox_h=100),
        DetectedRegion(bbox_x=500, bbox_y=1300, bbox_w=200, bbox_h=100),
    ]

    expected = sort_manga_reading_order(regions, page_w, page_h)

    # Thử xáo trộn 20 lần ngẫu nhiên -> Kết quả luôn phải 100% giống nhau
    for _ in range(20):
        shuffled = list(regions)
        random.shuffle(shuffled)
        result = sort_manga_reading_order(shuffled, page_w, page_h)
        assert result == expected
