import asyncio
import logging
import threading
from typing import Optional, Union
import cv2
import numpy as np
from PIL import Image

from app.core.config import settings

logger = logging.getLogger(__name__)


class MangaOcrEngine:
    """
    Singleton Wrapper cho Manga-OCR model (kha-white/manga-ocr-base):
    - Thread-safe lazy loading với threading.Lock
    - Async Semaphore giới hạn số lượng inference song song (mặc định 1)
    - Tự động nhận diện GPU/CPU và đặt cache vào services/ai-worker/.cache/huggingface
    - Trả về text tiếng Nhật đã nhận diện, confidence mặc định None (nullable)
    """

    _instance: Optional["MangaOcrEngine"] = None
    _init_lock = threading.Lock()

    def __init__(self):
        self._mocr = None
        self._semaphore = asyncio.Semaphore(settings.OCR_MAX_CONCURRENT_INFERENCES)

    @classmethod
    def get_instance(cls) -> "MangaOcrEngine":
        if cls._instance is None:
            with cls._init_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _load_model(self):
        if self._mocr is None:
            with self._init_lock:
                if self._mocr is None:
                    logger.info("Initializing Manga-OCR model...")
                    from manga_ocr import MangaOcr
                    import torch

                    use_gpu = torch.cuda.is_available() and not settings.OCR_FORCE_CPU
                    logger.info(f"Loading Manga-OCR on {'CUDA GPU' if use_gpu else 'CPU'}...")
                    self._mocr = MangaOcr(force_cpu=not use_gpu)
                    logger.info("Manga-OCR model loaded successfully.")

    def set_mock_model(self, mock_mocr):
        """Cho phép inject mock model trong fast unit tests."""
        self._mocr = mock_mocr

    async def recognize_crop_async(
        self, crop_image: Union[Image.Image, np.ndarray]
    ) -> str:
        """
        Nhận diện chữ tiếng Nhật từ ảnh cắt (crop).
        Chạy inference trong threadpool dưới asyncio.Semaphore.
        """
        async with self._semaphore:
            return await asyncio.to_thread(self._recognize_sync, crop_image)

    def _recognize_sync(self, crop_image: Union[Image.Image, np.ndarray]) -> str:
        self._load_model()

        if isinstance(crop_image, np.ndarray):
            # Chuyển OpenCV BGR sang PIL Image RGB
            rgb = cv2.cvtColor(crop_image, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(rgb)
        else:
            pil_img = crop_image

        text = self._mocr(pil_img)
        return text.strip() if text else ""
