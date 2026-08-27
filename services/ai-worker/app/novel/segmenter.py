from dataclasses import dataclass, field
import re
from typing import Any, Dict, List, Optional

from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    NovelBlockNode,
    ParagraphBlockNode,
)

SEGMENTER_VERSION = "novel-v1"

# Nhận diện câu thoại tiếng Nhật (Japanese Dialogue quotation marks 「...」 và 『...』)
JP_DIALOGUE_PATTERN = re.compile(r"^\s*[「『\"“]")


@dataclass(frozen=True)
class TranslatableBlock:
    """
    Đơn vị phân đoạn văn bản dịch thuật (Block Segment):
    - anchor_block_id: Định danh bất biến trong cùng source snapshot và traversal version.
    - sort_order: Thứ tự đọc tuyến tính (1-indexed).
    - block_type: Phân loại khối (HEADING, PARAGRAPH, DIALOGUE, NARRATION, BLOCKQUOTE).
    - raw_text: Plain text thuần túy cần dịch.
    - meta: Thông tin bổ trợ (heading level, quote context).
    """
    anchor_block_id: str
    sort_order: int
    block_type: str
    raw_text: str
    meta: Dict[str, Any] = field(default_factory=dict)


class NovelSegmenter:
    """
    Bộ phân đoạn tài liệu tiểu thuyết thành danh sách TranslatableBlocks chuẩn hóa:
    - version: 'novel-v1'
    - Thuật toán duyệt DFS deterministic 100%
    - Tách biệt câu thoại (Dialogue) và lời dẫn (Narration)
    """

    def __init__(self, version: str = SEGMENTER_VERSION):
        self.version = version

    def segment_document(self, doc: CanonicalNovelDocument) -> List[TranslatableBlock]:
        """
        Duyệt cây AST của tài liệu và trích xuất danh sách TranslatableBlock theo thứ tự tuyến tính.
        """
        segments: List[TranslatableBlock] = []
        block_counter = 0

        for block in doc.blocks:
            extracted = self._process_block(block, block_counter)
            for seg in extracted:
                block_counter += 1
                segments.append(seg)

        return segments

    def _process_block(self, block: NovelBlockNode, current_index: int) -> List[TranslatableBlock]:
        results: List[TranslatableBlock] = []

        if isinstance(block, HeadingBlockNode):
            text = block.to_plain_text()
            if text:
                block_id = f"blk_{current_index + 1:04d}_h{block.level}"
                results.append(
                    TranslatableBlock(
                        anchor_block_id=block_id,
                        sort_order=current_index + 1,
                        block_type="HEADING",
                        raw_text=text,
                        meta={"heading_level": block.level, "segmenter_version": self.version},
                    )
                )

        elif isinstance(block, ParagraphBlockNode):
            text = block.to_plain_text()
            if text:
                is_dialogue = bool(JP_DIALOGUE_PATTERN.match(text))
                block_type = "DIALOGUE" if is_dialogue else "NARRATION"
                suffix = "dlg" if is_dialogue else "p"
                block_id = f"blk_{current_index + 1:04d}_{suffix}"
                results.append(
                    TranslatableBlock(
                        anchor_block_id=block_id,
                        sort_order=current_index + 1,
                        block_type=block_type,
                        raw_text=text,
                        meta={"is_dialogue": is_dialogue, "segmenter_version": self.version},
                    )
                )

        elif isinstance(block, BlockquoteBlockNode):
            # Với blockquote, duyệt các block con hoặc trích xuất plain text
            text = block.to_plain_text()
            if text:
                block_id = f"blk_{current_index + 1:04d}_quote"
                results.append(
                    TranslatableBlock(
                        anchor_block_id=block_id,
                        sort_order=current_index + 1,
                        block_type="BLOCKQUOTE",
                        raw_text=text,
                        meta={"segmenter_version": self.version},
                    )
                )

        elif isinstance(block, (IllustrationBlockNode, DividerBlockNode)):
            # Thẻ ảnh và thẻ phân đoạn không tạo TranslatableBlock (được Rebuilder bảo toàn nguyên vị trí)
            pass

        return results
