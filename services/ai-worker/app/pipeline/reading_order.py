from typing import List
from app.pipeline.detector import DetectedRegion


def sort_manga_reading_order(
    regions: List[DetectedRegion], page_width: int, page_height: int
) -> List[DetectedRegion]:
    """
    Sắp xếp các vùng phát hiện theo thứ tự đọc Manga truyền thống của Nhật Bản (RTL + TTB):
    - Từ trên xuống dưới theo từng hàng / panel (Top-to-Bottom)
    - Từ phải sang trái trong cùng một hàng (Right-to-Left)
    - Deterministic 100% không phụ thuộc thứ tự đầu vào
    """
    if not regions:
        return []

    if len(regions) == 1:
        return list(regions)

    # 1. Gom nhóm theo các hàng (Vertical Bands)
    # Ngưỡng phân tách hàng: 12% chiều cao trang hoặc 50% chiều cao của box
    band_threshold = max(page_height * 0.12, 50.0)

    # Sắp xếp sơ bộ theo Y tăng dần
    sorted_by_y = sorted(regions, key=lambda r: (r.bbox_y, -r.bbox_x))

    rows: List[List[DetectedRegion]] = []
    current_row: List[DetectedRegion] = []
    current_row_y = sorted_by_y[0].bbox_y

    for r in sorted_by_y:
        center_y = r.bbox_y + r.bbox_h / 2.0
        if not current_row:
            current_row.append(r)
            current_row_y = center_y
        else:
            # Nếu box nằm trong cùng band_threshold với hàng hiện tại
            if abs(center_y - current_row_y) <= band_threshold:
                current_row.append(r)
                # Cập nhật center Y trung bình
                current_row_y = sum(x.bbox_y + x.bbox_h / 2.0 for x in current_row) / len(current_row)
            else:
                rows.append(current_row)
                current_row = [r]
                current_row_y = center_y

    if current_row:
        rows.append(current_row)

    # 2. Sắp xếp trong mỗi hàng từ Phải sang Trái (X giảm dần)
    ordered_regions: List[DetectedRegion] = []
    for row in rows:
        # Sắp xếp theo cạnh phải giảm dần (hoặc center_x giảm dần)
        sorted_row = sorted(row, key=lambda r: (r.bbox_x + r.bbox_w), reverse=True)
        ordered_regions.extend(sorted_row)

    return ordered_regions
