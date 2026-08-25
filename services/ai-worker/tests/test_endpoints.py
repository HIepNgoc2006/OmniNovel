import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, AsyncMock
from main import app
from app.core.config import settings

client = TestClient(app)
AUTH_HEADERS = {"X-Internal-Service-Key": settings.AI_WORKER_SECRET}

def test_health_check():
    response = client.get("/internal/v1/jobs/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "omninovel-ai-worker"

def test_process_manga_missing_key():
    response = client.post(
        "/internal/v1/jobs/process-manga",
        json={
            "jobId": "11111111-1111-1111-1111-111111111111",
            "attemptNumber": 1,
            "outputPrefix": "ai/jobs/11111111-1111-1111-1111-111111111111/attempt-1/",
        },
    )
    assert response.status_code == 401
    assert "Missing internal service secret" in response.json()["detail"]

def test_process_manga_invalid_key():
    response = client.post(
        "/internal/v1/jobs/process-manga",
        headers={"X-Internal-Service-Key": "wrong_key_secret"},
        json={
            "jobId": "11111111-1111-1111-1111-111111111111",
            "attemptNumber": 1,
            "outputPrefix": "ai/jobs/11111111-1111-1111-1111-111111111111/attempt-1/",
        },
    )
    assert response.status_code == 401
    assert "Invalid internal service secret" in response.json()["detail"]

@patch("app.api.v1.endpoints.jobs.request_output_upload_urls")
@patch("app.api.v1.endpoints.jobs.upload_file_to_presigned_url")
@patch("app.api.v1.endpoints.jobs.send_callback_event")
def test_process_manga_happy_path(mock_send_event, mock_upload, mock_request_urls):
    mock_request_urls.return_value = [
        {
            "filename": "page-001.webp",
            "storageKey": "ai/jobs/11111111-1111-1111-1111-111111111111/attempt-1/page-001.webp",
            "uploadUrl": "http://localhost:9000/manga-media/upload",
        }
    ]
    mock_upload.return_value = True
    mock_send_event.return_value = True

    response = client.post(
        "/internal/v1/jobs/process-manga",
        headers=AUTH_HEADERS,
        json={
            "jobId": "11111111-1111-1111-1111-111111111111",
            "attemptNumber": 1,
            "outputPrefix": "ai/jobs/11111111-1111-1111-1111-111111111111/attempt-1/",
            "sourceLang": "ja",
            "targetLang": "vi",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["status"] == "READY_FOR_REVIEW"
    assert data["pagesProcessed"] == 1
    # Kiểm tra callback được gọi đủ 7 stages: PREPROCESSING -> OCR -> TRANSLATING -> INPAINTING -> TYPESETTING -> QUALITY_CHECK -> READY_FOR_REVIEW
    assert mock_send_event.call_count == 7

@patch("app.api.v1.endpoints.jobs.send_callback_event")
def test_process_novel_happy_path(mock_send_event):
    mock_send_event.return_value = True

    response = client.post(
        "/internal/v1/jobs/process-novel",
        headers=AUTH_HEADERS,
        json={
            "jobId": "22222222-2222-2222-2222-222222222222",
            "attemptNumber": 1,
            "outputPrefix": "ai/jobs/22222222-2222-2222-2222-222222222222/attempt-1/",
            "sourceLang": "ja",
            "targetLang": "vi",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["status"] == "READY_FOR_REVIEW"
    assert data["segmentsCount"] == 1
    # Novel: PREPROCESSING -> TRANSLATING -> QUALITY_CHECK -> READY_FOR_REVIEW (4 calls)
    assert mock_send_event.call_count == 4
