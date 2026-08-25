import asyncio
import logging
from typing import Optional
from app.pipeline.progress_sink import ProgressSink

logger = logging.getLogger(__name__)


class HeartbeatEmitter:
    """
    Heartbeat Emitter chạy background async task gửi periodic heartbeat (mỗi 15s)
    qua ProgressSink trong khi model đang load hoặc inference, tránh để Watchdog abort job.
    """

    def __init__(
        self,
        sink: ProgressSink,
        stage: str = "OCR",
        interval_seconds: float = 15.0,
    ):
        self.sink = sink
        self.stage = stage
        self.interval_seconds = interval_seconds
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._current_progress = 10

    def set_progress(self, progress: int):
        self._current_progress = progress

    async def _loop(self):
        try:
            while self._running:
                await asyncio.sleep(self.interval_seconds)
                if not self._running:
                    break
                try:
                    await self.sink.emit_progress(
                        progress=self._current_progress,
                        stage=self.stage,
                        heartbeat=True,
                        message="Heartbeat keep-alive during OCR processing",
                    )
                except Exception as err:
                    logger.warning(f"Failed to emit heartbeat: {err}")
        except asyncio.CancelledError:
            pass

    def start(self):
        if not self._running:
            self._running = True
            self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
