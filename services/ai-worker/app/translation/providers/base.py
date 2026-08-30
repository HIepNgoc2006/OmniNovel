from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, List, Optional
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


@dataclass(frozen=True)
class TranslatedNovelBlockItem:
    anchor_block_id: str
    translated_text: str


class TranslationProvider(ABC):
    """Abstract Base Class cho các Translation Providers (Manga & Novel)."""

    @abstractmethod
    async def translate_batch(
        self, batch: ContextBatch, prompt_version: str = "manga-ja-vi-v1"
    ) -> List[TranslatedSegmentItem]:
        """Dịch một Manga ContextBatch và trả về danh sách TranslatedSegmentItem."""
        pass

    async def translate_novel_batch(
        self, batch: Any, prompt_version: str = "novel-ja-vi-v1"
    ) -> List[TranslatedNovelBlockItem]:
        """Dịch một NovelTranslationBatch và trả về danh sách TranslatedNovelBlockItem."""
        raise NotImplementedError("Provider chưa hỗ trợ dịch NovelTranslationBatch.")

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

    def _validate_novel_output_keys(
        self,
        input_items: List[Any],
        output_items: List[TranslatedNovelBlockItem],
    ) -> None:
        """
        Xác thực tính toàn vẹn 1:1 của tập hợp anchorBlockId trong NovelTranslationBatch:
        - Invariant 1 (Input Uniqueness): Input không được chứa anchorBlockId trùng lặp.
        - Invariant 2 (Output Uniqueness): Output không được chứa anchorBlockId trùng lặp.
        - Invariant 3 (Cardinality Invariant): len(output_items) == len(input_items).
        - Invariant 4 (Exact Set Equality): set(output_keys) == set(input_keys).
        """
        input_keys = [item.anchor_block_id for item in input_items]
        output_keys = [item.anchor_block_id for item in output_items]

        # 1. Kiểm tra trùng anchorBlockId trong input
        if len(input_keys) != len(set(input_keys)):
            seen_in = set()
            duplicates_in = [k for k in input_keys if k in seen_in or seen_in.add(k)]
            raise SchemaMismatchError(
                f"DUPLICATE_NOVEL_INPUT_KEY: Input chứa các anchorBlockId bị trùng lặp: {duplicates_in}"
            )

        # 2. Kiểm tra trùng anchorBlockId trong output
        if len(output_keys) != len(set(output_keys)):
            seen_out = set()
            duplicates_out = [k for k in output_keys if k in seen_out or seen_out.add(k)]
            raise SchemaMismatchError(
                f"DUPLICATE_NOVEL_OUTPUT_KEY: Provider trả về các anchorBlockId bị trùng lặp: {duplicates_out}"
            )

        # 3. Kiểm tra số lượng block (Cardinality)
        if len(output_keys) != len(input_keys):
            raise SchemaMismatchError(
                f"CARDINALITY_MISMATCH: Số lượng block output ({len(output_keys)}) không khớp với input ({len(input_keys)})."
            )

        # 4. Kiểm tra tập hợp (Exact Set Equality)
        input_set = set(input_keys)
        output_set = set(output_keys)

        if input_set != output_set:
            missing = list(input_set - output_set)
            extra = list(output_set - input_set)
            err_parts = []
            if missing:
                err_parts.append(f"Thiếu các anchorBlockId: {missing}")
            if extra:
                err_parts.append(f"Thừa các anchorBlockId không xác định: {extra}")
            raise SchemaMismatchError(
                f"SCHEMA_NOVEL_KEY_MISMATCH: Tập hợp anchorBlockId không khớp 1:1 giữa input và output. {'; '.join(err_parts)}"
            )


