from dataclasses import dataclass
import re
from typing import Any, Dict, List, Optional, Set
import unicodedata

from app.novel.segmenter import TranslatableBlock


@dataclass(frozen=True)
class GlossaryConstraint:
    """
    Ràng buộc thuật ngữ được trích xuất từ từ điển (Glossary Snapshot):
    - source_term: Thuật ngữ nguồn gốc (giữ nguyên Unicode nguồn).
    - target_term: Thuật ngữ đích tiếng Việt tương ứng.
    - category: Phân loại (character, location, skill, item, general).
    - notes: Ghi chú ngữ cảnh bổ sung.
    """
    source_term: str
    target_term: str
    category: str = "general"
    notes: Optional[str] = None


@dataclass(frozen=True)
class _ShadowGlossaryEntry:
    normalized_source: str
    original_source: str
    target_term: str
    category: str
    notes: Optional[str]


class NovelGlossaryEngine:
    """
    Bộ khớp thuật ngữ chuyên dụng cho Light Novel (Novel Glossary Engine):
    - Khớp từ điển Shadow String NFKC: Chuẩn hóa compatibility shadow string để nhận diện linh hoạt full-width/half-width
      và ký tự tương thích mà TUYỆT ĐỐI KHÔNG làm biến đổi Unicode nguồn (raw_text bất biến 100%).
    - Thuật toán Non-Overlapping Longest-Match-First: Khớp các cụm từ dài nhất trước và đánh dấu occupied spans
      để ngăn chặn các cụm từ con ngắn hơn bị match đè lên (vd: '魔王の城' sẽ chiếm trọn span, không match thêm '魔王' lồng bên trong).
    - Ràng buộc bất biến: Anchor ID là identity duy nhất của block.
    """

    def __init__(self, glossary_entries: Optional[List[Dict[str, Any]]] = None):
        self._entries: List[_ShadowGlossaryEntry] = []
        if glossary_entries:
            self._compile_entries(glossary_entries)

    def _compile_entries(self, raw_entries: List[Dict[str, Any]]) -> None:
        entries: List[_ShadowGlossaryEntry] = []
        for e in raw_entries:
            src = str(e.get("source_term", "")).strip()
            tgt = str(e.get("target_term", "")).strip()
            if not src or not tgt:
                continue

            category = str(e.get("category", "general"))
            notes = e.get("notes")
            norm_src = unicodedata.normalize("NFKC", src)

            entries.append(
                _ShadowGlossaryEntry(
                    normalized_source=norm_src,
                    original_source=src,
                    target_term=tgt,
                    category=category,
                    notes=str(notes) if notes is not None else None,
                )
            )

        # Sắp xếp Longest-Match-First theo độ dài thuật ngữ chuẩn hóa giảm dần
        entries.sort(key=lambda x: len(x.normalized_source), reverse=True)
        self._entries = entries

    def match_blocks(self, blocks: List[TranslatableBlock]) -> Dict[str, List[GlossaryConstraint]]:
        """
        Quét danh sách TranslatableBlocks và trả về mapping: anchor_block_id -> List[GlossaryConstraint].
        Bảo toàn 100% Unicode raw_text của blocks.
        """
        results: Dict[str, List[GlossaryConstraint]] = {}
        if not self._entries:
            return results

        for block in blocks:
            matched = self.match_single_text(block.raw_text)
            if matched:
                results[block.anchor_block_id] = matched

        return results

    def match_single_text(self, raw_text: str) -> List[GlossaryConstraint]:
        """
        Khớp từ điển trên một đoạn văn bản đơn lẻ qua Shadow String NFKC và Non-Overlapping Spans.
        """
        if not raw_text or not self._entries:
            return []

        shadow_text = unicodedata.normalize("NFKC", raw_text)
        matched_constraints: List[GlossaryConstraint] = []
        seen_targets: Set[str] = set()
        occupied_spans: List[tuple[int, int]] = []

        for entry in self._entries:
            term = entry.normalized_source
            term_len = len(term)
            start_pos = 0

            # Tìm tất cả vị trí xuất hiện của term trong shadow_text
            while True:
                idx = shadow_text.find(term, start_pos)
                if idx == -1:
                    break

                match_start = idx
                match_end = idx + term_len

                # Kiểm tra span có bị overlap với bất kỳ span nào đã chiếm trước đó không
                overlaps = any(
                    not (match_end <= occ_start or match_start >= occ_end)
                    for occ_start, occ_end in occupied_spans
                )

                if not overlaps:
                    occupied_spans.append((match_start, match_end))
                    if entry.target_term not in seen_targets:
                        matched_constraints.append(
                            GlossaryConstraint(
                                source_term=entry.original_source,
                                target_term=entry.target_term,
                                category=entry.category,
                                notes=entry.notes,
                            )
                        )
                        seen_targets.add(entry.target_term)

                start_pos = idx + 1

        return matched_constraints

