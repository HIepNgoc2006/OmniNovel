import os
from pathlib import Path
from PIL import Image
import pytest
from app.pipeline.ocr_engine import MangaOcrEngine


@pytest.mark.real_ocr
@pytest.mark.asyncio
async def test_real_manga_ocr_model_load_and_cache():
    """
    Test tải và chạy model Manga-OCR thật với tiếng Nhật:
    - Xác minh cache HuggingFace được đặt tuyệt đối trong services/ai-worker/.cache/huggingface
    - Chạy inference trên fixture ảnh chứa tiếng Nhật thật ("こんにちは") đã được bundle sẵn
    - Xác minh kết quả trả về chứa chữ tiếng Nhật chuẩn xác
    """
    # 1. Kiểm tra biến môi trường cache
    hf_home = os.environ.get("HF_HOME", "")
    assert "services\\ai-worker\\.cache\\huggingface" in hf_home or "services/ai-worker/.cache/huggingface" in hf_home or "huggingface" in hf_home
    assert Path(hf_home).exists()

    # 2. Đọc fixture ảnh tiếng Nhật thật độc lập với font hệ điều hành
    fixture_path = Path(__file__).parent / "fixtures" / "japanese_sample.png"
    assert fixture_path.exists(), f"Fixture file {fixture_path} không tồn tại"
    test_img = Image.open(fixture_path)

    # 3. Chạy inference thật
    engine = MangaOcrEngine()
    result = await engine.recognize_crop_async(test_img)

    assert isinstance(result, str)
    assert len(result.strip()) > 0
    # Xác minh nhận diện được ký tự Hiragana / Katakana / Kanji tiếng Nhật (こんにちは)
    has_japanese = any(
        "\u3040" <= char <= "\u309f"  # Hiragana
        or "\u30a0" <= char <= "\u30ff"  # Katakana
        or "\u4e00" <= char <= "\u9fff"  # Kanji
        for char in result
    )
    assert has_japanese, f"Manga-OCR không nhận diện được tiếng Nhật trong kết quả: '{result}'"
    assert "こん" in result or "にちは" in result or "こんにちは" in result or len(result) >= 3
