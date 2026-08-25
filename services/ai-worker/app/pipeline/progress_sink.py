import uuid
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
import httpx
from fastapi import HTTPException
from app.core.config import settings


class ProgressSink(ABC):
    """Abstraction tiếp nhận tiến độ và heartbeat của pipeline xử lý AI."""

    @abstractmethod
    async def emit_progress(
        self,
        progress: int,
        stage: str,
        heartbeat: bool = False,
        message: str = "",
        sequence: Optional[int] = None,
        result_manifest: Optional[Dict[str, Any]] = None,
        segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Gửi cập nhật tiến độ hoặc trạng thái."""
        pass

    async def emit_heartbeat(
        self,
        sequence: int,
        stage: str,
        progress: int,
    ) -> None:
        """Gửi keep-alive heartbeat định kỳ."""
        await self.emit_progress(
            progress=progress,
            stage=stage,
            heartbeat=True,
            sequence=sequence,
        )


class NoopProgressSink(ProgressSink):
    """Sink rỗng không làm gì, an toàn dùng cho standalone pipeline execution."""

    async def emit_progress(
        self,
        progress: int,
        stage: str,
        heartbeat: bool = False,
        message: str = "",
        sequence: Optional[int] = None,
        result_manifest: Optional[Dict[str, Any]] = None,
        segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        pass


class RecordingProgressSink(ProgressSink):
    """Sink ghi nhận tất cả events vào bộ nhớ phục vụ unit test và verification."""

    def __init__(self):
        self.events: List[Dict[str, Any]] = []

    async def emit_progress(
        self,
        progress: int,
        stage: str,
        heartbeat: bool = False,
        message: str = "",
        sequence: Optional[int] = None,
        result_manifest: Optional[Dict[str, Any]] = None,
        segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self.events.append(
            {
                "progress": progress,
                "stage": stage,
                "heartbeat": heartbeat,
                "message": message,
                "sequence": sequence,
                "resultManifest": result_manifest,
                "segments": segments or [],
            }
        )


class CoreCallbackProgressSink(ProgressSink):
    """Sink chuyển tiếp event lên NestJS Core API Callback Endpoint theo đúng Contract Slice 1/2C."""

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
        self,
        progress: int,
        stage: str,
        heartbeat: bool = False,
        message: str = "",
        sequence: Optional[int] = None,
        result_manifest: Optional[Dict[str, Any]] = None,
        segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        seq = sequence if sequence is not None else self.sequence
        if sequence is None:
            self.sequence += 1

        payload: Dict[str, Any] = {
            "eventId": str(uuid.uuid4()),
            "attemptNumber": self.attempt_number,
            "sequence": seq,
            "stage": stage,
            "progress": progress,
            "heartbeat": heartbeat,
            "resultManifest": result_manifest,
            "segments": segments if segments is not None else [],
        }

        url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{self.job_id}/events"
        headers = {
            "Content-Type": "application/json",
            "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
        }

        try:
            if self._client is not None:
                response = await self._client.post(url, json=payload, headers=headers, timeout=10.0)
            else:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.post(url, json=payload, headers=headers)

            if response.status_code not in (200, 201):
                raise HTTPException(
                    status_code=502,
                    detail=f"Core API callback event for stage {stage} (seq {seq}) failed with status {response.status_code}: {response.text}",
                )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to send callback event to Core API: {str(e)}",
            ) from e
