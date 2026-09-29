import os
from pathlib import Path
from typing import Optional, Literal
from pydantic_settings import BaseSettings, SettingsConfigDict

_AI_WORKER_DIR = Path(__file__).resolve().parent.parent.parent
_CACHE_DIR = _AI_WORKER_DIR / ".cache"

_HF_HOME = os.environ.get("HF_HOME") or str(_CACHE_DIR / "huggingface")
_TORCH_HOME = os.environ.get("TORCH_HOME") or str(_CACHE_DIR / "torch")

Path(_HF_HOME).mkdir(parents=True, exist_ok=True)
Path(_TORCH_HOME).mkdir(parents=True, exist_ok=True)

os.environ.setdefault("HF_HOME", _HF_HOME)
os.environ.setdefault("TORCH_HOME", _TORCH_HOME)

class Settings(BaseSettings):
    ENV: str = "production"
    AI_WORKER_TEST_MODE: bool = False
    AI_WORKER_PORT: int = 8001
    AI_WORKER_SECRET: str
    CORE_API_INTERNAL_URL: str = "http://localhost:8000"

    # Object Storage Provider (minio | r2) & S3 / R2 Configuration (SSoT với Core API)
    STORAGE_PROVIDER: Literal["minio", "r2"] = "minio"
    S3_ENDPOINT: Optional[str] = None
    S3_REGION: Optional[str] = None
    S3_BUCKET_MANGA: Optional[str] = None
    S3_BUCKET_NOVEL: Optional[str] = None

    # MinIO Local Configuration
    MINIO_ENDPOINT: str = "localhost"
    MINIO_PORT: int = 9000
    MINIO_USE_SSL: bool = False

    # Model & Inference Settings
    OCR_MODEL_NAME: str = "kha-white/manga-ocr-base"
    OCR_FORCE_CPU: bool = False
    OCR_MAX_CONCURRENT_INFERENCES: int = 1

    # Security & Archive Limits (SSoT với Core API)
    MAX_ARCHIVE_DOWNLOAD_BYTES: int = 100 * 1024 * 1024  # 100MB
    MAX_UNCOMPRESSED_ARCHIVE_BYTES: int = 100 * 1024 * 1024  # 100MB
    COMPRESSION_RATIO_LIMIT: float = 100.0  # 100:1
    MAX_ZIP_ENTRIES: int = 500
    MAX_MANGA_PAGES: int = 200
    MAX_IMAGE_AXIS_DIMENSION: int = 4096
    MAX_IMAGE_PIXELS: int = 4096 * 4096  # 16MP per page

    model_config = SettingsConfigDict(
        env_file=("../../.env", ".env"),
        extra="ignore",
    )

settings = Settings()
