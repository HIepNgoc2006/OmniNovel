import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import pytest
from app.pipeline.ocr_engine import MangaOcrEngine


def _create_japanese_test_image(text: str = "こんにちは") -> Image.Image:
    """Tạo ảnh test chứa chữ tiếng Nhật thực tế."""
    font = None
    candidate_fonts = [
        "C:/Windows/Fonts/msgothic.ttc",
        "C:/Windows/Fonts/msmincho.ttc",
        "C:/Windows/Fonts/meiryo.ttc",
        "C:/Windows/Fonts/yumin.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
    ]
    for fp in candidate_fonts:
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, 36)
                break
            except Exception:
                pass

    if font is None:
        font = ImageFont.load_default()

    img = Image.new("RGB", (250, 70), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.text((10, 10), text, fill=(0, 0, 0), font=font)
    return img


@pytest.mark.real_ocr
@pytest.mark.asyncio
async def test_real_manga_ocr_model_load_and_cache():
    """
    Test tải và chạy model Manga-OCR thật với tiếng Nhật:
    - Xác minh cache HuggingFace được đặt tuyệt đối trong services/ai-worker/.cache/huggingface
    - Chạy inference trên ảnh chứa tiếng Nhật thật ("こんにちは")
    - Xác minh kết quả trả về chứa chữ tiếng Nhật chuẩn xác
    """
    # 1. Kiểm tra biến môi trường cache
    hf_home = os.environ.get("HF_HOME", "")
    assert "services\\ai-worker\\.cache\\huggingface" in hf_home or "services/ai-worker/.cache/huggingface" in hf_home
    assert Path(hf_home).exists()

    # 2. Tạo ảnh test chứa chữ tiếng Nhật thật
    test_img = _create_japanese_test_image("こんにちは")

    # 3. Chạy inference thật
    engine = MangaOcrEngine()
    result = await engine.recognize_crop_async(test_img)

    assert isinstance(result, str)
    assert len(result.strip()) > 0
    # Xác minh nhận diện được ký tự Hiragana / Katakana / Kanji tiếng Nhật
    has_japanese = any(
        '\u3040' <= c <= '\u309f' or '\u30a0' <= c <= '\u30ff' or '\u4e00' <= c <= '\u9faf'
        for c in result
    )
    assert has_japanese
    assert "こんにちは" in result or "こん" in result

    # 4. Xác minh model cache directory tồn tại
    cache_hf = Path(hf_home)
    assert cache_hf.is_dir()
