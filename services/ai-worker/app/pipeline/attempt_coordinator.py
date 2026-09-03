import asyncio
import logging
from typing import Any, Dict, List, Optional, Union

from app.models.manifests import MangaResultManifestV1, NovelResultManifestV1
from app.pipeline.progress_sink import ProgressSink

logger = logging.getLogger(__name__)


class AttemptProgressCoordinator:
    """
    Coordinator quản lý toàn bộ sequence, heartbeat và state transitions cho 1 attempt duy nhất:
    - Thread/Concurrency-safe: Bảo vệ sequence và toàn bộ luồng emission bằng asyncio.Lock critical section.
    - Strict Outbound Serialization: Giữ lock trong suốt quá trình phát HTTP callback, ngăn ngừa
      triệt để tình huống heartbeat của stage cũ phát sau khi stage mới đã chuyển đổi.
    - Canonical 10s Heartbeat: Mặc định phát keep-alive mỗi 10 giây.
    - Final-only segments: Intermediate transitions gửi segments=[], chỉ emit_ready mới gửi final segments.
    """

    def __init__(
        self,
        sink: ProgressSink,
        interval_seconds: float = 10.0,
    ):
        self.sink = sink
        self.interval_seconds = interval_seconds
        self._lock = asyncio.Lock()
        self._sequence = 0
        self._current_stage = "PREPROCESSING"
        self._current_progress = 0
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._running = False

    @property
    def current_stage(self) -> str:
        return self._current_stage

    @property
    def current_progress(self) -> int:
        return self._current_progress

    @property
    def sequence(self) -> int:
        return self._sequence

    def start(self) -> None:
        """Bắt đầu background heartbeat task."""
        if self._running:
            return
        self._running = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _heartbeat_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.interval_seconds)
                if not self._running:
                    break

                # Giữ lock trong toàn bộ quá trình emit để serialize tuyệt đối
                async with self._lock:
                    if not self._running:
                        break
                    self._sequence += 1
                    seq = self._sequence
                    stage = self._current_stage
                    progress = self._current_progress

                    await self.sink.emit_heartbeat(
                        sequence=seq,
                        stage=stage,
                        progress=progress,
                    )
                    logger.debug(
                        f"[Coordinator] Đã phát heartbeat: stage={stage}, seq={seq}, prog={progress}"
                    )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[Coordinator] Lỗi khi phát heartbeat: {e}")

    async def transition_stage(
        self,
        stage: str,
        progress: int,
        message: str = "",
    ) -> None:
        """
        Critical Section: Chuyển stage an toàn.
        Tăng sequence, cập nhật stage và progress, gửi event lên Core API trong cùng 1 lock block.
        """
        async with self._lock:
            self._sequence += 1
            self._current_stage = stage
            self._current_progress = progress
            seq = self._sequence

            await self.sink.emit_progress(
                progress=progress,
                stage=stage,
                message=message,
                sequence=seq,
                segments=[],
            )
            logger.info(f"[Coordinator] Transition sang stage {stage} (seq={seq}, prog={progress}%)")

    async def set_progress(self, progress: int, message: str = "") -> None:
        """Cập nhật tiến độ trong cùng stage."""
        async with self._lock:
            self._sequence += 1
            self._current_progress = progress
            seq = self._sequence
            stage = self._current_stage

            await self.sink.emit_progress(
                progress=progress,
                stage=stage,
                message=message,
                sequence=seq,
                segments=[],
            )

    async def emit_ready(
        self,
        result_manifest: Union[MangaResultManifestV1, NovelResultManifestV1],
        segments: List[Dict[str, Any]],
        message: str = "All pages translated, inpainted, typeset and verified",
    ) -> None:
        """
        Hoàn tất toàn bộ attempt:
        Dừng heartbeat task và gửi final callback READY_FOR_REVIEW kèm resultManifest và segments.
        """
        await self.stop()

        async with self._lock:
            self._sequence += 1
            self._current_stage = "READY_FOR_REVIEW"
            self._current_progress = 100
            seq = self._sequence

            await self.sink.emit_ready(
                result_manifest=result_manifest,
                segments=segments,
                message=message,
                sequence=seq,
            )
            logger.info(
                f"[Coordinator] Hoàn tất attempt với READY_FOR_REVIEW (seq={seq}, segments={len(segments)})"
            )

    async def stop(self) -> None:
        """Dừng an toàn background heartbeat task."""
        self._running = False
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None
