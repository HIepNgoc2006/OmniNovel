from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    AI_WORKER_PORT: int = 8001
    AI_WORKER_SECRET: str = "internal_ai_worker_secret_secure_2026"
    CORE_API_INTERNAL_URL: str = "http://localhost:8000"
    MINIO_ENDPOINT: str = "localhost"
    MINIO_PORT: int = 9000

    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()
