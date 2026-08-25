import pytest
from fastapi.testclient import TestClient
from main import app
from app.core.config import settings

client = TestClient(app)

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
