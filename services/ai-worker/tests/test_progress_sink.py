import asyncio
import uuid
import httpx
import pytest
from app.core.config import settings
from app.pipeline.heartbeat_emitter import HeartbeatEmitter
from app.pipeline.progress_sink import (
    CoreCallbackProgressSink,
    NoopProgressSink,
    RecordingProgressSink,
)


@pytest.mark.asyncio
async def test_recording_progress_sink():
    sink = RecordingProgressSink()
    await sink.emit_progress(progress=15, stage="OCR", message="Starting")
    await sink.emit_progress(progress=50, stage="OCR", heartbeat=True, message="Keepalive")

    assert len(sink.events) == 2
    assert sink.events[0]["progress"] == 15
    assert sink.events[0]["heartbeat"] is False
    assert sink.events[1]["heartbeat"] is True


@pytest.mark.asyncio
async def test_heartbeat_emitter_periodic():
    sink = RecordingProgressSink()
    emitter = HeartbeatEmitter(sink=sink, stage="OCR", interval_seconds=0.05)

    emitter.set_progress(30)
    emitter.start()

    # Đợi 120ms để ít nhất 2 heartbeat được bắn ra
    await asyncio.sleep(0.13)
    await emitter.stop()

    heartbeats = [e for e in sink.events if e.get("heartbeat") is True]
    assert len(heartbeats) >= 2
    for hb in heartbeats:
        assert hb["stage"] == "OCR"
        assert hb["progress"] == 30


@pytest.mark.asyncio
async def test_noop_progress_sink_safe():
    sink = NoopProgressSink()
    # Không ném lỗi
    await sink.emit_progress(progress=10, stage="OCR")


@pytest.mark.asyncio
async def test_core_callback_progress_sink_contract():
    captured_requests = []

    def mock_handler(request: httpx.Request):
        captured_requests.append(request)
        return httpx.Response(200, json={"success": True})

    transport = httpx.MockTransport(mock_handler)
    mock_client = httpx.AsyncClient(transport=transport)

    job_id = "a0000000-0000-4000-a000-000000000001"
    sink = CoreCallbackProgressSink(job_id=job_id, attempt_number=1, sequence_start=1, client=mock_client)

    await sink.emit_progress(progress=30, stage="OCR", heartbeat=False, message="Processing page 1")

    assert len(captured_requests) == 1
    req = captured_requests[0]
    # Kiểm tra route: POST /internal/v1/ai/jobs/:id/events
    assert req.method == "POST"
    assert req.url.path == f"/internal/v1/ai/jobs/{job_id}/events"
    # Kiểm tra header: X-Internal-Service-Key
    assert req.headers.get("X-Internal-Service-Key") == settings.AI_WORKER_SECRET

    # Kiểm tra payload
    import json
    payload = json.loads(req.content.decode("utf-8"))
    assert payload["attemptNumber"] == 1
    assert payload["sequence"] == 1
    assert payload["stage"] == "OCR"
    assert payload["progress"] == 30
    assert payload["heartbeat"] is False

    # Invariant: eventId phải là UUID hợp lệ
    parsed_uuid = uuid.UUID(payload["eventId"])
    assert str(parsed_uuid) == payload["eventId"]


@pytest.mark.asyncio
async def test_core_callback_progress_sink_propagates_http_error():
    def mock_error_handler(request: httpx.Request):
        return httpx.Response(401, json={"message": "Unauthorized"})

    transport = httpx.MockTransport(mock_error_handler)
    mock_client = httpx.AsyncClient(transport=transport)

    job_id = "a0000000-0000-4000-a000-000000000001"
    sink = CoreCallbackProgressSink(job_id=job_id, attempt_number=1, client=mock_client)

    # Invariant: Core trả 4xx/5xx phải ném lỗi để caller biết
    with pytest.raises(httpx.HTTPStatusError):
        await sink.emit_progress(progress=50, stage="OCR")
