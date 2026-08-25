from dataclasses import dataclass
from typing import Dict, List, Optional
from app.translation.glossary_engine import GlossaryConstraint, GlossaryEngine


@dataclass(frozen=True)
class MangaSegmentItem:
    page_number: int
    sort_order: int
    bbox_x: int
    bbox_y: int
    bbox_w: int
    bbox_h: int
    raw_text: str
    confidence: Optional[float] = None

    @property
    def segment_key(self) -> str:
        """Định danh opaque duy nhất toàn chapter dạng p0001-s0001."""
        return f"p{self.page_number:04d}-s{self.sort_order:04d}"


@dataclass(frozen=True)
class ContextBatchItem:
    segment_key: str
    raw_text: str
    page_number: int
    sort_order: int
    surrounding_context: List[str]
    glossary_constraints: List[GlossaryConstraint]


@dataclass(frozen=True)
class ContextBatch:
    batch_index: int
    items: List[ContextBatchItem]


class MangaContextBuilder:
    """
    Xây dựng ngữ cảnh phân cấp và đóng gói batch cho dịch thuật Manga:
    - Sinh và xác thực segmentKey duy nhất toàn chapter (chống va chạm sortOrder trùng giữa các trang).
    - Ngữ cảnh lân cận dạng sliding window (Previous 2 + Next 1) trong cùng trang.
    - Khớp GlossaryConstraints cho từng segment mà không làm thay đổi rawText.
    - Phân chia batch theo ngân sách ký tự (MAX_CONTEXT_CHARS) và số lượng segment (MAX_ITEMS_PER_BATCH).
    """

    def __init__(
        self,
        glossary_engine: Optional[GlossaryEngine] = None,
        max_items_per_batch: int = 15,
        max_context_chars: int = 2500,
    ):
        self.glossary_engine = glossary_engine or GlossaryEngine()
        self.max_items_per_batch = max_items_per_batch
        self.max_context_chars = max_context_chars

    def build_batches(self, segments: List[MangaSegmentItem]) -> List[ContextBatch]:
        """
        Xây dựng danh sách ContextBatch từ danh sách segments OCR.
        Fail-fast nếu phát hiện segmentKey bị trùng lặp.
        """
        if not segments:
            return []

        # 1. Guardrail: Kiểm tra tính duy nhất tuyệt đối của segmentKey trên toàn chapter
        seen_keys: set[str] = set()
        for s in segments:
            key = s.segment_key
            if key in seen_keys:
                raise ValueError(
                    f"SEGMENT_KEY_COLLISION: Phát hiện segmentKey trùng lặp '{key}' "
                    f"tại page {s.page_number}, sortOrder {s.sort_order}."
                )
            seen_keys.add(key)

        # 2. Gom nhóm segment theo trang và sắp xếp theo sort_order
        pages_map: Dict[int, List[MangaSegmentItem]] = {}
        for s in segments:
            pages_map.setdefault(s.page_number, []).append(s)

        for p_num in pages_map:
            pages_map[p_num].sort(key=lambda x: x.sort_order)

        # 3. Tạo ContextBatchItem với sliding window context trong từng trang
        all_items: List[ContextBatchItem] = []
        for p_num in sorted(pages_map.keys()):
            page_segs = pages_map[p_num]
            total_in_page = len(page_segs)

            for idx, cur_seg in enumerate(page_segs):
                # Lấy tối đa 2 segment trước và 1 segment sau trong cùng trang
                surrounding: List[str] = []
                start_prev = max(0, idx - 2)
                for prev_idx in range(start_prev, idx):
                    surrounding.append(f"[Trước #{page_segs[prev_idx].sort_order}]: {page_segs[prev_idx].raw_text}")

                if idx + 1 < total_in_page:
                    surrounding.append(f"[Sau #{page_segs[idx + 1].sort_order}]: {page_segs[idx + 1].raw_text}")

                # Khớp glossary constraints
                constraints = self.glossary_engine.find_constraints(cur_seg.raw_text)

                item = ContextBatchItem(
                    segment_key=cur_seg.segment_key,
                    raw_text=cur_seg.raw_text,
                    page_number=cur_seg.page_number,
                    sort_order=cur_seg.sort_order,
                    surrounding_context=surrounding,
                    glossary_constraints=constraints,
                )
                all_items.append(item)

        # 4. Phân chia batch theo số lượng và ngân sách ký tự
        batches: List[ContextBatch] = []
        current_batch_items: List[ContextBatchItem] = []
        current_batch_chars = 0
        batch_idx = 1

        for item in all_items:
            item_chars = len(item.raw_text) + sum(len(c) for c in item.surrounding_context)
            if current_batch_items and (
                len(current_batch_items) >= self.max_items_per_batch
                or current_batch_chars + item_chars > self.max_context_chars
            ):
                batches.append(ContextBatch(batch_index=batch_idx, items=current_batch_items))
                batch_idx += 1
                current_batch_items = []
                current_batch_chars = 0

            current_batch_items.append(item)
            current_batch_chars += item_chars

        if current_batch_items:
            batches.append(ContextBatch(batch_index=batch_idx, items=current_batch_items))

        return batches
