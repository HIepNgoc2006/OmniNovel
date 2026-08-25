from typing import Optional, Sequence, Tuple
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.translation.manga_translator import MangaTranslatedSegmentResult
from app.typesetting.font_manager import FontManager
from app.typesetting.text_wrapper import _get_text_width, wrap_vietnamese_text


class TypesettingOverflowError(ValueError):
    """Ném ra khi văn bản không thể fit vừa khung bubble dù ở kích thước MIN_FONT_SIZE."""
    pass


class MangaTypesetter:
    """
    Engine dàn trang Manga chữ tiếng Việt:
    - Dynamic Font Fitting: Thuật toán tối ưu co giãn font size từ MAX_FONT_SIZE (36) đến MIN_FONT_SIZE (12).
    - Canh lề (Center alignment) hoàn hảo cả ngang và dọc bên trong khung bubble.
    - Render sắc nét với Pillow ImageDraw và viền nét (stroke) chống chìm nền.
    - Xuất typeset_mask đánh dấu vùng pixel chữ được vẽ phục vụ QA invariant testing.
    """

    def __init__(
        self,
        font_manager: Optional[FontManager] = None,
        max_font_size: int = 36,
        min_font_size: int = 12,
        stroke_width: int = 2,
    ):
        self.font_manager = font_manager or FontManager()
        self.max_font_size = max_font_size
        self.min_font_size = min_font_size
        self.stroke_width = stroke_width

    def render_page(
        self,
        image_bgr: np.ndarray,
        segments: Sequence[MangaTranslatedSegmentResult],
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Dàn trang chữ tiếng Việt lên trang tranh manga:
        Trả về:
          - rendered_bgr: Ảnh BGR đã chèn chữ tiếng Việt.
          - typeset_mask: 1-channel binary mask ghi nhận các pixel chữ đã vẽ.
        """
        img_h, img_w = image_bgr.shape[:2]
        img_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(img_rgb)
        draw = ImageDraw.Draw(pil_img)

        typeset_mask_pil = Image.new("L", (img_w, img_h), 0)
        draw_mask = ImageDraw.Draw(typeset_mask_pil)

        for seg in segments:
            text = (seg.translated_text or "").strip()
            if not text:
                continue

            # Tính toán không gian hiển thị bên trong bubble (đã trừ padding 8%)
            pad_x = max(3, int(seg.bbox_w * 0.08))
            pad_y = max(3, int(seg.bbox_h * 0.08))
            avail_w = seg.bbox_w - 2 * pad_x
            avail_h = seg.bbox_h - 2 * pad_y

            if avail_w <= 10 or avail_h <= 10:
                raise TypesettingOverflowError(
                    f"TYPESETTING_OVERFLOW: Khung bubble {seg.segment_key} quá nhỏ ({avail_w}x{avail_h}px) "
                    "không thể dàn trang an toàn."
                )

            # Dynamic Font Size Fitting
            best_font: Optional[ImageFont.FreeTypeFont] = None
            best_lines: Optional[list[str]] = None
            best_size: Optional[int] = None
            best_line_h: int = 0

            for sz in range(self.max_font_size, self.min_font_size - 1, -1):
                font = self.font_manager.get_font(sz)
                lines = wrap_vietnamese_text(text, font, avail_w)
                if not lines:
                    continue

                # Ước tính chiều cao từng dòng
                bbox_sample = font.getbbox("AygÁg")
                line_h = bbox_sample[3] - bbox_sample[1]
                line_spacing = max(2, int(line_h * 0.2))
                total_h = len(lines) * line_h + (len(lines) - 1) * line_spacing

                # Kiểm tra xem toàn bộ các dòng có nằm trọn vẹn trong avail_w và avail_h không
                all_fit_w = all(_get_text_width(l, font) <= avail_w for l in lines)
                if all_fit_w and total_h <= avail_h:
                    best_font = font
                    best_lines = lines
                    best_size = sz
                    best_line_h = line_h
                    break

            if best_font is None or best_lines is None:
                raise TypesettingOverflowError(
                    f"TYPESETTING_OVERFLOW: Bản dịch của segment {seg.segment_key} dài quá mức, "
                    f"không thể vừa khung {avail_w}x{avail_h}px dù ở MIN_FONT_SIZE ({self.min_font_size}px)."
                )

            # Căn giữa dọc (Vertical centering)
            line_spacing = max(2, int(best_line_h * 0.2))
            total_block_h = len(best_lines) * best_line_h + (len(best_lines) - 1) * line_spacing
            start_y = seg.bbox_y + pad_y + (avail_h - total_block_h) // 2

            cur_y = start_y
            for line in best_lines:
                lw = _get_text_width(line, best_font)
                # Căn giữa ngang (Horizontal centering)
                start_x = seg.bbox_x + pad_x + (avail_w - lw) // 2

                # Vẽ lên ảnh chính: Chữ đen, viền trắng mỏng (stroke) tạo độ tương phản cao
                draw.text(
                    (start_x, cur_y),
                    line,
                    font=best_font,
                    fill=(10, 10, 10),
                    stroke_width=self.stroke_width,
                    stroke_fill=(255, 255, 255),
                )

                # Vẽ lên mask đánh dấu pixel chữ
                draw_mask.text(
                    (start_x, cur_y),
                    line,
                    font=best_font,
                    fill=255,
                    stroke_width=self.stroke_width + 1,
                    stroke_fill=255,
                )

                cur_y += best_line_h + line_spacing

        rendered_rgb = np.array(pil_img)
        rendered_bgr = cv2.cvtColor(rendered_rgb, cv2.COLOR_RGB2BGR)
        typeset_mask = np.array(typeset_mask_pil)

        return rendered_bgr, typeset_mask
