import uuid
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Union
import httpx
from fastapi import HTTPException
from app.core.config import settings
from app.models.manifests import MangaResultManifestV1, NovelResultManifestV1


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
        segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Gửi cập nhật tiến độ hoặc trạng thái (chỉ dành cho intermediate stages)."""
        pass

    async def emit_ready(
        self,
        result_manifest: Any,
        segments: Optional[List[Dict[str, Any]]] = None,
        message: str = "All stages completed and verified",
        sequence: Optional[int] = None,
    ) -> None:
        """Gửi final event READY_FOR_REVIEW với typed Pydantic result manifest."""
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
        segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        pass

    async def emit_ready(
        self,
        result_manifest: Union[MangaResultManifestV1, NovelResultManifestV1],
        segments: Optional[List[Dict[str, Any]]] = None,
        message: str = "All stages completed and verified",
        sequence: Optional[int] = None,
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
        segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self.events.append(
            {
                "progress": progress,
                "stage": stage,
                "heartbeat": heartbeat,
                "message": message,
                "sequence": sequence,
                "segments": segments or [],
            }
        )

    async def emit_ready(
        self,
        result_manifest: Any,
        segments: Optional[List[Dict[str, Any]]] = None,
        message: str = "All stages completed and verified",
        sequence: Optional[int] = None,
    ) -> None:
        if hasattr(result_manifest, "model_dump"):
            dumped_manifest = result_manifest.model_dump(mode="json", exclude_none=True, by_alias=True)
        else:
            dumped_manifest = result_manifest

        self.events.append(
            {
                "progress": 100,
                "stage": "READY_FOR_REVIEW",
                "heartbeat": False,
                "message": message,
                "sequence": sequence,
                "resultManifest": dumped_manifest,
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
            "message": message,
            "segments": segments if segments is not None else [],
        }

        await self._send_payload(payload, stage, seq)

    async def emit_ready(
        self,
        result_manifest: Any,
        segments: Optional[List[Dict[str, Any]]] = None,
        message: str = "All stages completed and verified",
        sequence: Optional[int] = None,
    ) -> None:
        seq = sequence if sequence is not None else self.sequence
        if sequence is None:
            self.sequence += 1

        # Duy nhất tại đây model_dump() sang JSON Dict trước khi gửi qua HTTP
        if hasattr(result_manifest, "model_dump"):
            manifest_payload = result_manifest.model_dump(
                mode="json",
                exclude_none=True,
                by_alias=True,
            )
        else:
            manifest_payload = result_manifest

        payload: Dict[str, Any] = {
            "eventId": str(uuid.uuid4()),
            "attemptNumber": self.attempt_number,
            "sequence": seq,
            "stage": "READY_FOR_REVIEW",
            "progress": 100,
            "heartbeat": False,
            "message": message,
            "resultManifest": manifest_payload,
            "segments": segments if segments is not None else [],
        }

        await self._send_payload(payload, "READY_FOR_REVIEW", seq)

    async def _send_payload(self, payload: Dict[str, Any], stage: str, seq: int) -> None:
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
