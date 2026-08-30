from dataclasses import dataclass, field
import re
from typing import Any, Dict, List, Optional, Tuple

from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    NovelBlockNode,
    ParagraphBlockNode,
)
from app.novel.inline_anchors import InlineAnchorCodec, InlineAnchorMap

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
    - raw_text: Chuỗi văn bản cần dịch (có thể chứa protected inline tags nếu preserve_inline_anchors=True).
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
    - Hỗ trợ mã hóa Protected Inline Anchors cho Ruby, Strong, Emphasis
    """

    def __init__(self, version: str = SEGMENTER_VERSION):
        self.version = version

    def segment_document(
        self,
        doc: CanonicalNovelDocument,
        preserve_inline_anchors: bool = True,
    ) -> List[TranslatableBlock]:
        """
        Duyệt cây AST của tài liệu và trích xuất danh sách TranslatableBlock theo thứ tự tuyến tính.
        """
        blocks, _ = self.segment_document_with_inline_anchors(doc, preserve_inline_anchors)
        return blocks

    def segment_document_with_inline_anchors(
        self,
        doc: CanonicalNovelDocument,
        preserve_inline_anchors: bool = True,
    ) -> Tuple[List[TranslatableBlock], Dict[str, InlineAnchorMap]]:
        """
        Duyệt cây AST của tài liệu và trích xuất cả TranslatableBlocks và bản đồ InlineAnchorMaps.
        """
        segments: List[TranslatableBlock] = []
        anchor_maps: Dict[str, InlineAnchorMap] = {}
        block_counter = 0

        for block in doc.blocks:
            extracted, extracted_maps = self._process_block(
                block, block_counter, preserve_inline_anchors
            )
            for seg in extracted:
                block_counter += 1
                segments.append(seg)
            anchor_maps.update(extracted_maps)

        return segments, anchor_maps

    def _process_block(
        self,
        block: NovelBlockNode,
        current_index: int,
        preserve_inline_anchors: bool,
    ) -> Tuple[List[TranslatableBlock], Dict[str, InlineAnchorMap]]:
        results: List[TranslatableBlock] = []
        maps: Dict[str, InlineAnchorMap] = {}

        if isinstance(block, HeadingBlockNode):
            if preserve_inline_anchors:
                text, amap, _ = InlineAnchorCodec.encode(block.children)
            else:
                text = block.to_plain_text()
                amap = InlineAnchorMap()

            if text:
                block_id = f"blk_{current_index + 1:04d}_h{block.level}"
                if amap.has_anchors():
                    maps[block_id] = amap
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
            if preserve_inline_anchors:
                text, amap, _ = InlineAnchorCodec.encode(block.children)
            else:
                text = block.to_plain_text()
                amap = InlineAnchorMap()

            if text:
                # Kiểm tra dialogue dựa trên plain text hoặc encoded text
                plain_check = block.to_plain_text()
                is_dialogue = bool(JP_DIALOGUE_PATTERN.match(plain_check))
                block_type = "DIALOGUE" if is_dialogue else "NARRATION"
                suffix = "dlg" if is_dialogue else "p"
                block_id = f"blk_{current_index + 1:04d}_{suffix}"
                if amap.has_anchors():
                    maps[block_id] = amap
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
            pass

        return results, maps

