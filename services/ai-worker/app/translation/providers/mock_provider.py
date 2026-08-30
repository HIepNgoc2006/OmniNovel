from typing import Any, Dict, List
from app.translation.context_builder import ContextBatch
from app.translation.providers.base import (
    TranslationProvider,
    TranslatedNovelBlockItem,
    TranslatedSegmentItem,
)

# Từ điển mẫu cơ bản phục vụ Mock Translation
_MOCK_JA_VI_DICT: Dict[str, str] = {
    "こんにちは": "Xin chào",
    "おはよう": "Chào buổi sáng",
    "ありがとう": "Cảm ơn",
    "さようなら": "Tạm biệt",
    "海賊王": "Vua Hải Tặc",
    "勇者": "Dũng sĩ",
    "世界": "Thế giới",
    "魔王": "Ma vương",
    "力": "Sức mạnh",
    "行くぞ": "Đi thôi nào",
}


class MockTranslationProvider(TranslationProvider):
    """
    Mock Translation Provider phục vụ unit test và testing nội bộ tốc độ cao:
    - 100% deterministic, không gọi mạng ngoài.
    - Áp dụng triệt để glossary constraints.
    - Validate tính toàn vẹn 1:1 của segmentKey / anchorBlockId.
    """

    async def translate_batch(
        self, batch: ContextBatch, prompt_version: str = "manga-ja-vi-v1"
    ) -> List[TranslatedSegmentItem]:
        results: List[TranslatedSegmentItem] = []

        for item in batch.items:
            translated = item.raw_text

            # 1. Áp dụng Glossary Constraints bắt buộc trước (Longest match)
            for c in item.glossary_constraints:
                if c.source_term in translated:
                    translated = translated.replace(c.source_term, c.target_term)

            # 2. Áp dụng từ điển cơ bản cho các từ còn lại
            for ja_word, vi_word in _MOCK_JA_VI_DICT.items():
                if ja_word in translated:
                    translated = translated.replace(ja_word, vi_word)

            # Nếu không có từ nào khớp, gắn tiền tố mẫu
            if translated == item.raw_text:
                translated = f"[Dịch: {item.raw_text}]"

            results.append(
                TranslatedSegmentItem(
                    segment_key=item.segment_key,
                    translated_text=translated,
                )
            )

        self._validate_output_keys(batch.items, results)
        return results

    async def translate_novel_batch(
        self, batch: Any, prompt_version: str = "novel-ja-vi-v1"
    ) -> List[TranslatedNovelBlockItem]:
        results: List[TranslatedNovelBlockItem] = []

        for item in batch.translate_blocks:
            translated = item.raw_text

            # 1. Áp dụng Glossary Constraints bắt buộc trước (Longest match)
            for c in item.glossary_constraints:
                if c.source_term in translated:
                    translated = translated.replace(c.source_term, c.target_term)

            # 2. Áp dụng từ điển cơ bản cho các từ còn lại
            for ja_word, vi_word in _MOCK_JA_VI_DICT.items():
                if ja_word in translated:
                    translated = translated.replace(ja_word, vi_word)

            if translated == item.raw_text:
                translated = f"[Dịch: {item.raw_text}]"

            results.append(
                TranslatedNovelBlockItem(
                    anchor_block_id=item.anchor_block_id,
                    translated_text=translated,
                )
            )

        self._validate_novel_output_keys(batch.translate_blocks, results)
        return results

