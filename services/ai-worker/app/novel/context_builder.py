from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.novel.glossary_engine import GlossaryConstraint
from app.novel.segmenter import TranslatableBlock
from app.novel.token_estimator import ConservativeTokenEstimator, TokenEstimator


@dataclass(frozen=True)
class NovelContextItem:
    """
    Phần tử văn bản bên trong Batch ngữ cảnh:
    - anchor_block_id: Định danh duy nhất bất biến của khối (Identity).
    - sort_order: Thứ tự đọc tuyến tính.
    - block_type: HEADING, PARAGRAPH, DIALOGUE, NARRATION, BLOCKQUOTE.
    - raw_text: Chuỗi văn bản Unicode gốc.
    - glossary_constraints: Danh sách ràng buộc thuật ngữ tương ứng.
    - is_dialogue: Cờ xác định câu thoại.
    - meta: Thông tin bổ trợ (heading level...).
    """
    anchor_block_id: str
    sort_order: int
    block_type: str
    raw_text: str
    glossary_constraints: List[GlossaryConstraint] = field(default_factory=list)
    is_dialogue: bool = False
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NovelTranslationBatch:
    """
    Gói dữ liệu dịch thuật có cấu trúc (Translation Batch):
    - batch_index: Chỉ số thứ tự của batch (0-indexed).
    - context_before: Danh sách các block ngữ cảnh đi trước (CHỈ DÙNG THAM KHẢO, KHÔNG ĐƯỢC DỊCH).
    - translate_blocks: Danh sách các block CHÍNH BẮT BUỘC PHẢI DỊCH trong đợt này.
    - context_after: Danh sách các block ngữ cảnh nhìn trước (CHỈ DÙNG THAM KHẢO, KHÔNG ĐƯỢC DỊCH).
    - estimated_tokens: Tổng số token ước tính của batch (gồm context + translate blocks).
    """
    batch_index: int
    context_before: List[NovelContextItem]
    translate_blocks: List[NovelContextItem]
    context_after: List[NovelContextItem]
    estimated_tokens: int


class NovelContextBuilder:
    """
    Bộ kiến tạo ngữ cảnh và phân gói dịch thuật cho Light Novel:
    - Gom cụm các TranslatableBlock thành các NovelTranslationBatch theo ngân sách token (`max_tokens_per_batch`).
    - Sliding Window Context: Quản lý cửa sổ trượt `context_before` và `context_after` giúp LLM hiểu đại từ xưng hô,
      giọng văn và nhân vật đang nói mà không dịch lặp lại các block cũ.
    - Invariant cứng: estimated_tokens(framing + context_before + translate_blocks + context_after) <= max_tokens_per_batch.
    - Ném ValueError rõ ràng nếu một block đơn lẻ vượt quá max_tokens_per_batch.
    """

    def __init__(
        self,
        token_estimator: Optional[TokenEstimator] = None,
        max_tokens_per_batch: int = 1500,
        max_context_tokens: int = 400,
        max_context_blocks: int = 3,
        max_lookahead_blocks: int = 2,
        framing_overhead_tokens: int = 50,
    ):
        self.estimator = token_estimator or ConservativeTokenEstimator()
        self.max_tokens_per_batch = max_tokens_per_batch
        self.max_context_tokens = max_context_tokens
        self.max_context_blocks = max_context_blocks
        self.max_lookahead_blocks = max_lookahead_blocks
        self.framing_overhead_tokens = framing_overhead_tokens

    def build_batches(
        self,
        blocks: List[TranslatableBlock],
        glossary_constraints_map: Optional[Dict[str, List[GlossaryConstraint]]] = None,
    ) -> List[NovelTranslationBatch]:
        """
        Phân tách danh sách TranslatableBlock thành các NovelTranslationBatch có cấu trúc ngữ cảnh trượt.
        """
        if not blocks:
            return []

        constraints_map = glossary_constraints_map or {}

        # 1. Chuyển đổi toàn bộ blocks thành NovelContextItem và thẩm định kích thước
        context_items: List[NovelContextItem] = []
        for b in blocks:
            constraints = constraints_map.get(b.anchor_block_id, [])
            is_dlg = b.block_type == "DIALOGUE" or bool(b.meta.get("is_dialogue", False))
            item_tokens = self.estimator.estimate_tokens(b.raw_text)

            # INVARIANT: Block đơn lẻ không được vượt quá max_tokens_per_batch
            if item_tokens + self.framing_overhead_tokens > self.max_tokens_per_batch:
                raise ValueError(
                    f"Oversized block detected: Block '{b.anchor_block_id}' ({item_tokens} tokens) "
                    f"vượt quá ngân sách tối đa của một batch ({self.max_tokens_per_batch} tokens). "
                    "Vui lòng phân tách đoạn văn này ở tầng tiền xử lý upstream."
                )

            context_items.append(
                NovelContextItem(
                    anchor_block_id=b.anchor_block_id,
                    sort_order=b.sort_order,
                    block_type=b.block_type,
                    raw_text=b.raw_text,
                    glossary_constraints=constraints,
                    is_dialogue=is_dlg,
                    meta=dict(b.meta),
                )
            )

        # 2. Ngân sách dành riêng cho các khối cần dịch chính (dành chỗ trống cho context & framing)
        core_translate_budget = max(50, self.max_tokens_per_batch - self.max_context_tokens - self.framing_overhead_tokens)

        # Phân cụm các translate_blocks theo core_translate_budget
        chunks: List[List[NovelContextItem]] = []
        current_chunk: List[NovelContextItem] = []
        current_chunk_tokens = 0

        for item in context_items:
            item_tokens = self.estimator.estimate_tokens(item.raw_text) + 10  # overhead per block

            if current_chunk and (current_chunk_tokens + item_tokens > core_translate_budget):
                chunks.append(current_chunk)
                current_chunk = [item]
                current_chunk_tokens = item_tokens
            else:
                current_chunk.append(item)
                current_chunk_tokens += item_tokens

        if current_chunk:
            chunks.append(current_chunk)

        # 3. Gắn Sliding Context Window (context_before & context_after) bảo đảm ngân sách cứng
        batches: List[NovelTranslationBatch] = []

        for batch_idx, active_chunk in enumerate(chunks):
            start_idx = context_items.index(active_chunk[0])
            end_idx = context_items.index(active_chunk[-1]) + 1

            chunk_tokens = sum(self.estimator.estimate_tokens(it.raw_text) + 10 for it in active_chunk)
            available_context_budget = max(0, self.max_tokens_per_batch - self.framing_overhead_tokens - chunk_tokens)

            # A. Allocation cho context_before
            context_before_budget = min(self.max_context_tokens, available_context_budget)
            context_before_candidates = context_items[max(0, start_idx - self.max_context_blocks):start_idx]
            context_before: List[NovelContextItem] = []
            used_before_tokens = 0

            for item in reversed(context_before_candidates):
                t_count = self.estimator.estimate_tokens(item.raw_text) + 5
                if used_before_tokens + t_count <= context_before_budget:
                    context_before.insert(0, item)
                    used_before_tokens += t_count
                else:
                    break

            # B. Allocation cho context_after (bị giới hạn bởi phần budget còn lại)
            remaining_after_budget = max(0, available_context_budget - used_before_tokens)
            context_after_candidates = context_items[end_idx:min(len(context_items), end_idx + self.max_lookahead_blocks)]
            context_after: List[NovelContextItem] = []
            used_after_tokens = 0

            for item in context_after_candidates:
                t_count = self.estimator.estimate_tokens(item.raw_text) + 5
                if used_after_tokens + t_count <= remaining_after_budget:
                    context_after.append(item)
                    used_after_tokens += t_count
                else:
                    break

            # Tổng token ước tính toàn bộ batch (framing + before + translate + after)
            total_batch_tokens = self.framing_overhead_tokens + chunk_tokens + used_before_tokens + used_after_tokens

            batches.append(
                NovelTranslationBatch(
                    batch_index=batch_idx,
                    context_before=context_before,
                    translate_blocks=active_chunk,
                    context_after=context_after,
                    estimated_tokens=total_batch_tokens,
                )
            )

        return batches

