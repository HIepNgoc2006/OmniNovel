from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Optional
from app.translation.context_builder import ContextBatch, ContextBatchItem


class TranslationProviderError(Exception):
    """Lỗi cơ sở cho các vấn đề liên quan đến Translation Provider."""
    pass


class RateLimitError(TranslationProviderError):
    """Lỗi 429 Too Many Requests từ Provider."""
    def __init__(self, message: str, retry_after: Optional[int] = None):
        super().__init__(message)
        self.retry_after = retry_after


class SchemaMismatchError(TranslationProviderError):
    """Lỗi khi cấu trúc JSON hoặc tập hợp segmentKey đầu ra không khớp 100% với đầu vào."""
    pass


class AuthenticationError(TranslationProviderError):
    """Lỗi 401/403 Unauthorized từ Provider."""
    pass


@dataclass(frozen=True)
class TranslatedSegmentItem:
    segment_key: str
    translated_text: str


class TranslationProvider(ABC):
    """Abstract Base Class cho các Translation Providers."""

    @abstractmethod
    async def translate_batch(
        self, batch: ContextBatch, prompt_version: str = "manga-ja-vi-v1"
    ) -> List[TranslatedSegmentItem]:
        """Dịch một ContextBatch và trả về danh sách TranslatedSegmentItem."""
        pass

    def _validate_output_keys(
        self,
        input_items: List[ContextBatchItem],
        output_items: List[TranslatedSegmentItem],
    ) -> None:
        """
        Xác thực tính toàn vẹn 1:1 của tập hợp segmentKey:
        - Không cho phép trùng key trong output.
        - Không cho phép thiếu key hoặc thừa key lạ.
        - Chấp nhận thứ tự key bị xáo trộn nếu ánh xạ đúng 100%.
        """
        input_keys = [item.segment_key for item in input_items]
        output_keys = [item.segment_key for item in output_items]

        # Kiểm tra trùng key trong output
        if len(output_keys) != len(set(output_keys)):
            seen = set()
            duplicates = [k for k in output_keys if k in seen or seen.add(k)]
            raise SchemaMismatchError(
                f"DUPLICATE_OUTPUT_KEY: Provider trả về các segmentKey bị trùng lặp: {duplicates}"
            )

        input_set = set(input_keys)
        output_set = set(output_keys)

        if input_set != output_set:
            missing = list(input_set - output_set)
            extra = list(output_set - input_set)
            err_parts = []
            if missing:
                err_parts.append(f"Thiếu các key: {missing}")
            if extra:
                err_parts.append(f"Thừa các key không xác định: {extra}")
            raise SchemaMismatchError(
                f"SCHEMA_KEY_MISMATCH: Tập hợp segmentKey không khớp 1:1 giữa input và output. {'; '.join(err_parts)}"
            )
