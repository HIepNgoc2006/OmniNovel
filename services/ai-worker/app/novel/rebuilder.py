import copy
import logging
from typing import Any, Dict, List, Optional, Tuple, Union

from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    NovelBlockNode,
    NovelInlineNode,
    ParagraphBlockNode,
    TextNode,
)
from app.novel.inline_anchors import InlineAnchorCodec, InlineAnchorMap
from app.novel.translator import TranslatedNovelBlock

logger = logging.getLogger(__name__)


class NovelRebuilderError(Exception):
    """Lỗi cơ sở trong quá trình tái cấu trúc tài liệu Novel."""
    pass


class MissingAnchorBlockError(NovelRebuilderError):
    """Lỗi khi không tìm thấy kết quả dịch cho một anchorBlockId bắt buộc."""
    pass


class NovelDocumentRebuilder:
    """
    Bộ tái cấu trúc cây Document AST hoàn chỉnh (Novel Document Rebuilder):
    - Invariant 1 (Source Immutability): Tuyệt đối không mutate cây source AST gốc,
      luôn tạo và trả về một cây CanonicalNovelDocument mới hoàn toàn.
    - Invariant 2 (Anchor Mapping 1:1): Khớp từng block dịch vào đúng vị trí cây AST qua anchor_block_id.
    - Invariant 3 (Protected Inline Preservation): Giải mã các protected tags ⟦...⟧ để tái tạo đúng
      các node StrongNode, EmphasisNode, RubyNode và InlineImageNode với furigana gốc.
    - Invariant 4 (Structural Node Preservation): Giữ nguyên 100% IllustrationBlockNode và DividerBlockNode.
    """

    def __init__(self, fallback_to_raw_on_missing: bool = False):
        self.fallback_to_raw_on_missing = fallback_to_raw_on_missing

    def rebuild(
        self,
        source_doc: CanonicalNovelDocument,
        translated_blocks: Union[Dict[str, str], List[TranslatedNovelBlock]],
        anchor_maps: Optional[Dict[str, InlineAnchorMap]] = None,
        translated_title: Optional[str] = None,
    ) -> CanonicalNovelDocument:
        """
        Tái tạo cây CanonicalNovelDocument tiếng Việt từ cây nguồn và kết quả dịch.
        """
        # Chuẩn hóa translated_blocks thành Dict: anchor_block_id -> translated_text
        translation_map: Dict[str, str] = {}
        if isinstance(translated_blocks, dict):
            translation_map = dict(translated_blocks)
        elif isinstance(translated_blocks, list):
            for item in translated_blocks:
                if isinstance(item, TranslatedNovelBlock):
                    translation_map[item.anchor_block_id] = item.translated_text
                elif isinstance(item, dict):
                    aid = item.get("anchor_block_id") or item.get("anchorBlockId")
                    txt = item.get("translated_text") or item.get("translatedText", "")
                    if aid:
                        translation_map[aid] = txt

        maps = anchor_maps or {}
        block_counter = 0
        rebuilt_blocks: List[NovelBlockNode] = []

        for block in source_doc.blocks:
            rebuilt, block_counter = self._rebuild_block(
                block, block_counter, translation_map, maps
            )
            if rebuilt:
                rebuilt_blocks.append(rebuilt)

        # Tiêu đề mới (nếu có) hoặc giữ nguyên tiêu đề gốc
        new_title = translated_title if translated_title is not None else source_doc.title

        return CanonicalNovelDocument(
            blocks=rebuilt_blocks,
            title=new_title,
            language="vi",
            format=source_doc.format,
            metadata=copy.deepcopy(source_doc.metadata),
        )

    def _rebuild_block(
        self,
        block: NovelBlockNode,
        current_index: int,
        translations: Dict[str, str],
        anchor_maps: Dict[str, InlineAnchorMap],
    ) -> Tuple[Optional[NovelBlockNode], int]:
        """
        Tái tạo một block node đơn lẻ hoặc container blockquote.
        """
        from typing import Tuple

        if isinstance(block, HeadingBlockNode):
            current_index += 1
            block_id = f"blk_{current_index:04d}_h{block.level}"
            translated_text = translations.get(block_id)

            if translated_text is None:
                if not self.fallback_to_raw_on_missing:
                    raise MissingAnchorBlockError(f"Thiếu kết quả dịch cho Heading block '{block_id}'.")
                translated_text = block.to_plain_text()

            # Giải mã inline nodes
            amap = anchor_maps.get(block_id, InlineAnchorMap())
            new_children = InlineAnchorCodec.decode(translated_text, amap)

            return HeadingBlockNode(level=block.level, children=new_children), current_index

        elif isinstance(block, ParagraphBlockNode):
            current_index += 1
            # Xác định suffix giống như Segmenter
            raw_text = block.to_plain_text()
            from app.novel.segmenter import JP_DIALOGUE_PATTERN
            is_dialogue = bool(JP_DIALOGUE_PATTERN.match(raw_text))
            suffix = "dlg" if is_dialogue else "p"
            block_id = f"blk_{current_index:04d}_{suffix}"

            translated_text = translations.get(block_id)
            if translated_text is None:
                if not self.fallback_to_raw_on_missing:
                    raise MissingAnchorBlockError(f"Thiếu kết quả dịch cho Paragraph block '{block_id}'.")
                translated_text = raw_text

            amap = anchor_maps.get(block_id, InlineAnchorMap())
            new_children = InlineAnchorCodec.decode(translated_text, amap)

            return ParagraphBlockNode(children=new_children), current_index

        elif isinstance(block, BlockquoteBlockNode):
            current_index += 1
            block_id = f"blk_{current_index:04d}_quote"
            translated_text = translations.get(block_id)

            if translated_text is not None:
                # Nếu blockquote được dịch nguyên khối
                amap = anchor_maps.get(block_id, InlineAnchorMap())
                new_children = InlineAnchorCodec.decode(translated_text, amap)
                return BlockquoteBlockNode(children=[ParagraphBlockNode(children=new_children)]), current_index
            else:
                # Nếu blockquote chứa các sub-blocks
                sub_blocks: List[NovelBlockNode] = []
                for child in block.children:
                    rebuilt_child, current_index = self._rebuild_block(
                        child, current_index, translations, anchor_maps
                    )
                    if rebuilt_child:
                        sub_blocks.append(rebuilt_child)
                return BlockquoteBlockNode(children=sub_blocks), current_index

        elif isinstance(block, IllustrationBlockNode):
            # Sao chép nguyên vẹn node ảnh minh họa
            return IllustrationBlockNode(
                src=block.src,
                alt=block.alt,
                caption=block.caption,
                width=block.width,
                height=block.height,
            ), current_index

        elif isinstance(block, DividerBlockNode):
            # Sao chép thẻ phân đoạn
            return DividerBlockNode(), current_index

        return None, current_index
