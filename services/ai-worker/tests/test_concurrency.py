import asyncio
import numpy as np
import pytest
from app.pipeline.ocr_engine import MangaOcrEngine


class MockMangaOcr:
    def __init__(self):
        self.active_calls = 0
        self.max_concurrent_seen = 0

    def __call__(self, img):
        self.active_calls += 1
        if self.active_calls > self.max_concurrent_seen:
            self.max_concurrent_seen = self.active_calls
        # Giả lập thời gian xử lý ngắn
        import time
        time.sleep(0.02)
        self.active_calls -= 1
        return "テスト"


@pytest.mark.asyncio
async def test_ocr_engine_concurrency_lock():
    engine = MangaOcrEngine()
    mock_mocr = MockMangaOcr()
    engine.set_mock_model(mock_mocr)

    dummy_crop = np.ones((50, 100, 3), dtype=np.uint8) * 255

    # Chạy 5 tasks đồng thời qua recognize_crop_async
    tasks = [engine.recognize_crop_async(dummy_crop) for _ in range(5)]
    results = await asyncio.gather(*tasks)

    assert len(results) == 5
    assert all(r == "テスト" for r in results)
    # Vì Semaphore = 1 nên tại 1 thời điểm chỉ có 1 call được chạy
    assert mock_mocr.max_concurrent_seen == 1
