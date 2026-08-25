from abc import ABC, abstractmethod
from typing import Any, Dict, List
import httpx
from app.core.config import settings


class ProgressSink(ABC):
    """Abstraction tiếp nhận tiến độ và heartbeat của pipeline xử lý AI."""

    @abstractmethod
    async def emit_progress(
        self, progress: int, stage: str, heartbeat: bool = False, message: str = ""
    ) -> None:
        """Gửi cập nhật tiến độ hoặc heartbeat."""
        pass


class NoopProgressSink(ProgressSink):
    """Sink rỗng không làm gì, an toàn dùng cho standalone pipeline execution."""

    async def emit_progress(
        self, progress: int, stage: str, heartbeat: bool = False, message: str = ""
    ) -> None:
        pass


class RecordingProgressSink(ProgressSink):
    """Sink ghi nhận tất cả events vào bộ nhớ phục vụ unit test và verification."""

    def __init__(self):
        self.events: List[Dict[str, Any]] = []

    async def emit_progress(
        self, progress: int, stage: str, heartbeat: bool = False, message: str = ""
    ) -> None:
        self.events.append(
            {
                "progress": progress,
                "stage": stage,
                "heartbeat": heartbeat,
                "message": message,
            }
        )


class CoreCallbackProgressSink(ProgressSink):
    """Sink chuyển tiếp event lên NestJS Core API Callback Endpoint."""

    def __init__(self, job_id: str, attempt_number: int, sequence_start: int = 1):
        self.job_id = job_id
        self.attempt_number = attempt_number
        self.sequence = sequence_start

    async def emit_progress(
        self, progress: int, stage: str, heartbeat: bool = False, message: str = ""
    ) -> None:
        payload = {
            "eventId": f"{self.job_id}-{self.attempt_number}-{self.sequence}",
            "attemptNumber": self.attempt_number,
            "sequence": self.sequence,
            "stage": stage,
            "progress": progress,
            "heartbeat": heartbeat,
        }
        self.sequence += 1

        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{settings.CORE_API_INTERNAL_URL}/api/v1/internal/ai/jobs/{self.job_id}/events",
                json=payload,
                headers={"X-Worker-Secret": settings.AI_WORKER_SECRET},
            )
