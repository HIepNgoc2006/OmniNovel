from abc import ABC, abstractmethod
import re
from typing import Protocol, runtime_checkable

# CJK Characters: Hiragana, Katakana, CJK Unified Ideographs (Kanji), CJK Compatibility Ideographs, Full-width forms
CJK_REGEX = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]")


@runtime_checkable
class TokenEstimator(Protocol):
    """Giao thức ước tính số lượng Token cho văn bản đa ngôn ngữ."""

    def estimate_tokens(self, text: str) -> int:
        """Ước tính số token của chuỗi văn bản đầu vào."""
        ...


class ConservativeTokenEstimator:
    """
    Bộ ước tính Token thận trọng độc lập với model (Model-Agnostic & Deterministic):
    - Ký tự CJK (Kanji, Kana, chữ tượng hình): ~2.0 tokens/ký tự (độ bảo thủ cao chống vượt Context Window).
    - Ký tự Latin / số / khoảng trắng: ~0.25 - 0.5 tokens/ký tự (hoặc 1 token mỗi từ).
    - Tag / JSON framing overhead: Phụ phí cố định cho mỗi block.
    """

    def __init__(self, cjk_token_weight: float = 2.0, non_cjk_char_weight: float = 0.35, block_overhead_tokens: int = 8):
        self.cjk_token_weight = cjk_token_weight
        self.non_cjk_char_weight = non_cjk_char_weight
        self.block_overhead_tokens = block_overhead_tokens

    def estimate_tokens(self, text: str) -> int:
        if not text:
            return 0

        cjk_count = len(CJK_REGEX.findall(text))
        non_cjk_count = len(text) - cjk_count

        estimated = (cjk_count * self.cjk_token_weight) + (non_cjk_count * self.non_cjk_char_weight)
        return max(1, int(estimated + 0.5))

    def estimate_block_tokens(self, text: str) -> int:
        """Ước tính token của một khối văn bản bao gồm cả phụ phí định dạng block/JSON."""
        return self.estimate_tokens(text) + self.block_overhead_tokens
