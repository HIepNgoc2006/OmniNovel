import asyncio
import pytest

from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
from app.pipeline.progress_sink import RecordingProgressSink
from app.models.manifests import MangaResultManifestV1, MangaResultPageModel


@pytest.mark.asyncio
async def test_attempt_coordinator_monotonic_sequence_and_transitions():
    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink, interval_seconds=0.05)

    coordinator.start()

    # Transition 1: PREPROCESSING
    await coordinator.transition_stage("PREPROCESSING", 10, "Extracting")
    # Transition 2: OCR
    await coordinator.transition_stage("OCR", 30, "Detecting")
    # Transition 3: TRANSLATING
    await coordinator.transition_stage("TRANSLATING", 50, "Translating")

    # Cho heartbeat chạy 2-3 nhịp
    await asyncio.sleep(0.15)

    # Transition 4: INPAINTING
    await coordinator.transition_stage("INPAINTING", 70, "Inpainting")

    # Hoàn tất READY
    manifest = MangaResultManifestV1(
        version=1,
        mediaFormat="COMIC",
        pages=[
            MangaResultPageModel(
                page=1,
                storageKey="ai/jobs/1/att-1/p1.webp",
                previewKey="ai/jobs/1/att-1/p1.webp",
                width=1200,
                height=1800,
                fileSizeBytes=102400,
            )
        ]
    )
    segments = [{"pageNumber": 1, "sortOrder": 1, "rawText": "abc", "translatedText": "xyz"}]
    await coordinator.emit_ready(manifest, segments)

    events = sink.events
    assert len(events) >= 5

    # 1. Invariant: Sequence luôn tăng đơn điệu nghiêm ngặt
    sequences = [e["sequence"] for e in events]
    assert sequences == sorted(sequences)
    assert len(sequences) == len(set(sequences))  # Không có sequence nào bị trùng lặp

    # 2. Invariant: Intermediate events không chứa segments
    for ev in events[:-1]:
        assert ev["segments"] == []

    # 3. Invariant: Event cuối cùng là READY_FOR_REVIEW mang đầy đủ segments và manifest
    last_event = events[-1]
    assert last_event["stage"] == "READY_FOR_REVIEW"
    assert last_event["progress"] == 100
    assert last_event["resultManifest"] == manifest.model_dump(mode="json", exclude_none=True, by_alias=True)
    assert len(last_event["segments"]) == 1


@pytest.mark.asyncio
async def test_attempt_coordinator_no_stale_heartbeat_after_transition():
    sink = RecordingProgressSink()
    coordinator = AttemptProgressCoordinator(sink=sink, interval_seconds=0.05)

    coordinator.start()
    await coordinator.transition_stage("OCR", 30)

    # Chuyển sang TRANSLATING
    await coordinator.transition_stage("TRANSLATING", 50)

    # Đợi 2 nhịp heartbeat
    await asyncio.sleep(0.12)
    await coordinator.stop()

    events = sink.events
    translating_idx = next(i for i, e in enumerate(events) if e["stage"] == "TRANSLATING" and not e["heartbeat"])

    # Mọi event (kể cả heartbeat) sau index translating_idx BẮT BUỘC phải là TRANSLATING, không được là OCR
    for ev in events[translating_idx:]:
        assert ev["stage"] == "TRANSLATING", f"Phát hiện heartbeat stage cũ '{ev['stage']}' sau khi đã transition sang TRANSLATING"
