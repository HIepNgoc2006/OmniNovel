import unicodedata
from dataclasses import dataclass
from typing import List, Optional


@dataclass(frozen=True)
class GlossaryEntry:
    source_term: str
    target_term: str
    category: str = "CHARACTER_NAME"


@dataclass(frozen=True)
class GlossaryConstraint:
    source_term: str
    target_term: str
    category: str
    matched_span: str


class GlossaryEngine:
    """
    Engine khớp từ điển thuật ngữ chuyên biệt cho Manga Nhật:
    - Khớp trên chuỗi bóng chuẩn hóa (Shadow String NFKC) để phát hiện cả half-width & full-width variants (ＡＢＣ vs ABC).
    - Longest-match-first để ưu tiên thuật ngữ dài/phức hợp trước (e.g. 超サイヤ人ゴッド trước 超サイヤ人).
    - Khớp non-overlapping không xung đột.
    - BẢO TOÀN TUYỆT ĐỐI raw_text OCR, không biến đổi/overwrite dữ liệu gốc.
    """

    def __init__(self, entries: Optional[List[GlossaryEntry]] = None):
        raw_entries = entries or []
        # Sắp xếp ổn định: Longest-match first, sau đó theo source_term, target_term, category
        self.entries: List[GlossaryEntry] = sorted(
            [
                GlossaryEntry(
                    source_term=e.source_term.strip(),
                    target_term=e.target_term.strip(),
                    category=e.category or "CHARACTER_NAME",
                )
                for e in raw_entries
                if e.source_term and e.source_term.strip()
            ],
            key=lambda x: (-len(x.source_term), x.source_term, x.target_term, x.category),
        )

    def find_constraints(self, raw_text: str) -> List[GlossaryConstraint]:
        """
        Tìm kiếm các thuật ngữ glossary xuất hiện trong raw_text.
        Trả về danh sách GlossaryConstraint mà không làm thay đổi raw_text.
        """
        if not raw_text or not self.entries:
            return []

        # Tạo chuỗi bóng chuẩn hóa NFKC để matching
        shadow_text = unicodedata.normalize("NFKC", raw_text)
        matched_spans: List[tuple[int, int]] = []
        constraints: List[GlossaryConstraint] = []

        for entry in self.entries:
            normalized_source = unicodedata.normalize("NFKC", entry.source_term)
            if not normalized_source:
                continue

            start_idx = 0
            while True:
                pos = shadow_text.find(normalized_source, start_idx)
                if pos == -1:
                    break

                end_pos = pos + len(normalized_source)
                start_idx = end_pos

                # Kiểm tra non-overlapping với các span dài hơn đã khớp trước đó
                overlap = any(
                    not (end_pos <= exist_start or pos >= exist_end)
                    for exist_start, exist_end in matched_spans
                )
                if not overlap:
                    matched_spans.append((pos, end_pos))
                    constraints.append(
                        GlossaryConstraint(
                            source_term=entry.source_term,
                            target_term=entry.target_term,
                            category=entry.category,
                            matched_span=raw_text[pos:end_pos] if end_pos <= len(raw_text) else entry.source_term,
                        )
                    )

        return constraints
