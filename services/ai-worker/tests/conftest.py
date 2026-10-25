import pytest
from app.core.config import settings


@pytest.fixture(autouse=True)
def setup_test_settings(monkeypatch):
    """Thiết lập môi trường kiểm thử chuẩn hóa cho AI Worker (cô lập khỏi local .env production)."""
    monkeypatch.setattr(settings, "ENV", "test")
    monkeypatch.setattr(settings, "STORAGE_PROVIDER", "minio")
    monkeypatch.setattr(settings, "AI_WORKER_TEST_MODE", True)
