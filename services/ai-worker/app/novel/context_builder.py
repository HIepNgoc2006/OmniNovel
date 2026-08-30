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
    - Độc lập Token Estimator: Hỗ trợ bất kỳ implementation nào của TokenEstimator protocol.
    """

    def __init__(
        self,
        token_estimator: Optional[TokenEstimator] = None,
        max_tokens_per_batch: int = 1500,
        max_context_tokens: int = 400,
        max_context_blocks: int = 3,
        max_lookahead_blocks: int = 2,
    ):
        self.estimator = token_estimator or ConservativeTokenEstimator()
        self.max_tokens_per_batch = max_tokens_per_batch
        self.max_context_tokens = max_context_tokens
        self.max_context_blocks = max_context_blocks
        self.max_lookahead_blocks = max_lookahead_blocks

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

        # 1. Chuyển đổi toàn bộ blocks thành NovelContextItem
        context_items: List[NovelContextItem] = []
        for b in blocks:
            constraints = constraints_map.get(b.anchor_block_id, [])
            is_dlg = b.block_type == "DIALOGUE" or bool(b.meta.get("is_dialogue", False))
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

        # 2. Phân cụm các translate_blocks theo token budget
        chunks: List[List[NovelContextItem]] = []
        current_chunk: List[NovelContextItem] = []
        current_chunk_tokens = 0

        for item in context_items:
            item_tokens = self.estimator.estimate_tokens(item.raw_text) + 10  # overhead

            # Nếu thêm item này vượt quá max_tokens_per_batch (và current_chunk không rỗng) -> ngắt chunk mới
            if current_chunk and (current_chunk_tokens + item_tokens > self.max_tokens_per_batch):
                chunks.append(current_chunk)
                current_chunk = [item]
                current_chunk_tokens = item_tokens
            else:
                current_chunk.append(item)
                current_chunk_tokens += item_tokens

        if current_chunk:
            chunks.append(current_chunk)

        # 3. Gắn Sliding Context Window (context_before & context_after) cho từng batch
        batches: List[NovelTranslationBatch] = []

        for batch_idx, active_chunk in enumerate(chunks):
            # Tìm chỉ số index bắt đầu và kết thúc của active_chunk trong context_items
            start_idx = context_items.index(active_chunk[0])
            end_idx = context_items.index(active_chunk[-1]) + 1

            # context_before: Lấy tối đa max_context_blocks ngay trước start_idx
            context_before_candidates = context_items[max(0, start_idx - self.max_context_blocks):start_idx]
            context_before: List[NovelContextItem] = []
            ctx_tokens = 0
            for item in reversed(context_before_candidates):
                t_count = self.estimator.estimate_tokens(item.raw_text)
                if ctx_tokens + t_count <= self.max_context_tokens or not context_before:
                    context_before.insert(0, item)
                    ctx_tokens += t_count
                else:
                    break

            # context_after: Lấy tối đa max_lookahead_blocks ngay sau end_idx
            context_after = context_items[end_idx:min(len(context_items), end_idx + self.max_lookahead_blocks)]

            # Tính tổng tokens ước tính của toàn bộ batch
            all_texts = [it.raw_text for it in (context_before + active_chunk + context_after)]
            total_batch_tokens = sum(self.estimator.estimate_tokens(t) for t in all_texts) + len(active_chunk) * 15

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
