from typing import List
from PIL import ImageFont


def _get_text_width(text: str, font: ImageFont.FreeTypeFont) -> int:
    """Tính toán chiều rộng chính xác theo pixel của một dòng text."""
    if not text:
        return 0
    bbox = font.getbbox(text)
    return bbox[2] - bbox[0]


def wrap_vietnamese_text(
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width_px: int,
) -> List[str]:
    """
    Thuật toán bẻ dòng từ vựng tiếng Việt tự nhiên:
    - Xử lý các dấu ngắt dòng tường minh (\n).
    - Giữ trọn vẹn từ có dấu và combining marks.
    - Tự động bẻ ký tự nếu 1 từ đơn lẻ dài hơn max_width_px.
    """
    if not text:
        return []

    lines: List[str] = []
    paragraphs = text.split("\n")

    for para in paragraphs:
        para = para.strip()
        if not para:
            lines.append("")
            continue

        words = para.split()
        if not words:
            continue

        current_line = ""

        for word in words:
            # Trường hợp 1 từ đơn lẻ dài hơn cả max_width_px
            word_w = _get_text_width(word, font)
            if word_w > max_width_px:
                if current_line:
                    lines.append(current_line)
                    current_line = ""
                # Bẻ nhỏ từng ký tự của từ dài
                sub_word = ""
                for char in word:
                    test_sub = sub_word + char
                    if _get_text_width(test_sub, font) <= max_width_px:
                        sub_word = test_sub
                    else:
                        if sub_word:
                            lines.append(sub_word)
                        sub_word = char
                if sub_word:
                    current_line = sub_word
                continue

            test_line = f"{current_line} {word}".strip() if current_line else word
            if _get_text_width(test_line, font) <= max_width_px:
                current_line = test_line
            else:
                if current_line:
                    lines.append(current_line)
                current_line = word

        if current_line:
            lines.append(current_line)

    return lines
