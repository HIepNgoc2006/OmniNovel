FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    OCR_FORCE_CPU=true \
    OCR_MAX_CONCURRENT_INFERENCES=1 \
    AI_WORKER_PORT=8001 \
    HF_HOME=/home/appuser/.cache/huggingface \
    TORCH_HOME=/home/appuser/.cache/torch

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10001 appuser && \
    useradd -u 10001 -g appuser -m -s /bin/bash appuser

COPY services/ai-worker/requirements-prod-cpu.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/ai-worker/app ./app
COPY services/ai-worker/main.py ./main.py

RUN mkdir -p /home/appuser/.cache/huggingface /home/appuser/.cache/torch && \
    chown -R appuser:appuser /home/appuser /app

USER appuser

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://127.0.0.1:8001/internal/v1/jobs/health || exit 1

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
