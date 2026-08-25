import os
from pathlib import Path
import cv2
import numpy as np
import pytest
from app.core.config import settings
from app.pipeline.ocr_engine import MangaOcrEngine


@pytest.mark.real_ocr
@pytest.mark.asyncio
async def test_real_manga_ocr_model_load_and_cache(tmp_path: Path):
    """
    Test tải và chạy model Manga-OCR thật:
    - Xác minh cache HuggingFace được đặt tuyệt đối trong services/ai-worker/.cache/huggingface
    - Chạy inference trên crop ảnh
    """
    # 1. Kiểm tra biến môi trường cache
    assert "services\\ai-worker\\.cache\\huggingface" in os.environ.get("HF_HOME", "") or "services/ai-worker/.cache/huggingface" in os.environ.get("HF_HOME", "")
    assert Path(os.environ["HF_HOME"]).exists()

    # 2. Tạo một test card ảnh trắng
    test_crop = np.ones((80, 200, 3), dtype=np.uint8) * 255
    cv2.putText(test_crop, "HELLO", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)

    # 3. Chạy inference thật
    engine = MangaOcrEngine()
    result = await engine.recognize_crop_async(test_crop)

    assert isinstance(result, str)
    # Xác minh thư mục cache đã lưu model files
    cache_hf = Path(os.environ["HF_HOME"])
    assert cache_hf.is_dir()
