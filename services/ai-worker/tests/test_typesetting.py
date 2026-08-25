import numpy as np
import pytest

from app.translation.manga_translator import MangaTranslatedSegmentResult
from app.typesetting.font_manager import FontManager
from app.typesetting.text_wrapper import wrap_vietnamese_text
from app.typesetting.typesetter import MangaTypesetter, TypesettingOverflowError


def test_font_manager_loads_pinned_font():
    fm = FontManager()
    font14 = fm.get_font(14)
    font24 = fm.get_font(24)

    assert font14 is not None
    assert font24 is not None
    assert fm.get_font(14) is font14  # Cache verification


def test_text_wrapper_vietnamese_diacritics_and_long_words():
    fm = FontManager()
    font = fm.get_font(16)

    # 1. Câu tiếng Việt có đầy đủ dấu thanh
    text = "Tôi là người sẽ trở thành Vua Hải Tặc vĩ đại nhất thế giới này!"
    lines = wrap_vietnamese_text(text, font, max_width_px=150)

    assert len(lines) >= 3
    # Ghép lại phải đủ toàn bộ từ
    all_words = " ".join(lines).split()
    assert all_words == text.split()

    # 2. Xử lý từ cực dài không có khoảng trắng
    long_word_text = "SIEUCAPDAITUDONGLUONGTRUOCNAYCHUATUNNGTHAY"
    lines_long = wrap_vietnamese_text(long_word_text, font, max_width_px=80)
    assert len(lines_long) >= 2


def test_typesetter_dynamic_fitting_and_rendering():
    fm = FontManager()
    typesetter = MangaTypesetter(font_manager=fm)

    # Tạo ảnh trắng 400x300
    img = np.full((400, 300, 3), 255, dtype=np.uint8)

    seg = MangaTranslatedSegmentResult(
        page_number=1,
        sort_order=1,
        bbox_x=50,
        bbox_y=50,
        bbox_w=150,
        bbox_h=100,
        raw_text="オレは海賊王になる！",
        translated_text="Tôi sẽ trở thành Vua Hải Tặc!",
    )

    rendered_bgr, typeset_mask = typesetter.render_page(img, [seg])

    assert rendered_bgr.shape == img.shape
    assert typeset_mask.shape == (400, 300)

    # Mask chữ đã vẽ phải có pixel hoạt động bên trong bounding box
    active_pixels = np.count_nonzero(typeset_mask)
    assert active_pixels > 100

    # Pixel ngoài bounding box phải không bị chạm vào
    outside_mask = typeset_mask.copy()
    outside_mask[50:150, 50:200] = 0
    assert np.count_nonzero(outside_mask) == 0


def test_typesetting_overflow_raises_error():
    typesetter = MangaTypesetter(min_font_size=12)
    img = np.full((200, 200, 3), 255, dtype=np.uint8)

    # Khung quá bé (20x15 px) nhưng chứa đoạn văn dài
    tiny_seg = MangaTranslatedSegmentResult(
        page_number=1,
        sort_order=1,
        bbox_x=10,
        bbox_y=10,
        bbox_w=20,
        bbox_h=15,
        raw_text="Long text",
        translated_text="Đoạn văn này quá dài không thể nào nhét vừa một khung bé tí tẹo!",
    )

    with pytest.raises(TypesettingOverflowError, match="TYPESETTING_OVERFLOW"):
        typesetter.render_page(img, [tiny_seg])
