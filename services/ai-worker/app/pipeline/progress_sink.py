import uuid
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
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
    """Sink chuyển tiếp event lên NestJS Core API Callback Endpoint theo đúng Contract Slice 1."""

    def __init__(
        self,
        job_id: str,
        attempt_number: int,
        sequence_start: int = 1,
        client: Optional[httpx.AsyncClient] = None,
    ):
        self.job_id = job_id
        self.attempt_number = attempt_number
        self.sequence = sequence_start
        self._client = client

    async def emit_progress(
        self, progress: int, stage: str, heartbeat: bool = False, message: str = ""
    ) -> None:
        payload = {
            "eventId": str(uuid.uuid4()),
            "attemptNumber": self.attempt_number,
            "sequence": self.sequence,
            "stage": stage,
            "progress": progress,
            "heartbeat": heartbeat,
        }
        self.sequence += 1

        url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{self.job_id}/events"
        headers = {"X-Internal-Service-Key": settings.AI_WORKER_SECRET}

        if self._client is not None:
            response = await self._client.post(url, json=payload, headers=headers)
            response.raise_for_status()
        else:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()
