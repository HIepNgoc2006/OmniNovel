import asyncio
import pytest
from app.pipeline.heartbeat_emitter import HeartbeatEmitter
from app.pipeline.progress_sink import NoopProgressSink, RecordingProgressSink


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
