from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    AI_WORKER_PORT: int = 8001
    AI_WORKER_SECRET: str
    CORE_API_INTERNAL_URL: str = "http://localhost:8000"
    MINIO_ENDPOINT: str = "localhost"
    MINIO_PORT: int = 9000

    model_config = SettingsConfigDict(
        env_file=("../../.env", ".env"),
        extra="ignore",
    )

settings = Settings()
