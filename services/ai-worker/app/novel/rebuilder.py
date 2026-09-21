import copy
import logging
from typing import Any, Dict, List, Optional, Set, Tuple, Union

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
from app.novel.inline_anchors import (
    InlineAnchorCodec,
    InlineAnchorMap,
    InlineAnchorMismatchError,
)
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
    - Invariant 2 (Defense-in-depth Anchor Mapping 1:1):
      + Enforce tính duy nhất của expected IDs và supplied IDs.
      + Enforce Cardinality và Exact Set Equality giữa source blocks và translated blocks.
      + Bắt lỗi và reject lập tức các block dư thừa (extra) hoặc thiếu (missing).
    - Invariant 3 (Protected Inline Preservation): Giải mã các protected tags ⟦...⟧ ở chế độ strict
      để tái tạo đúng các node StrongNode, EmphasisNode, RubyNode và InlineImageNode với furigana gốc.
    - Invariant 4 (Structural Node Preservation): Giữ nguyên 100% IllustrationBlockNode và DividerBlockNode.
    """

    def __init__(self, fallback_to_raw_on_missing: bool = False):
        self.fallback_to_raw_on_missing = fallback_to_raw_on_missing

    def rebuild(
        self,
        source_doc: CanonicalNovelDocument,
        translated_blocks: Union[Dict[str, str], List[TranslatedNovelBlock], List[Dict[str, Any]]],
        anchor_maps: Optional[Dict[str, InlineAnchorMap]] = None,
        translated_title: Optional[str] = None,
        target_language: Optional[str] = None,
    ) -> CanonicalNovelDocument:
        """
        Tái tạo cây CanonicalNovelDocument từ cây nguồn và kết quả dịch.
        """
        # 1. Trích xuất expected segments từ source document để xác định tập hợp anchor IDs cần có
        from app.novel.segmenter import NovelSegmenter
        segmenter = NovelSegmenter()
        expected_segments, expected_maps = segmenter.segment_document_with_inline_anchors(source_doc)
        expected_ids = [seg.anchor_block_id for seg in expected_segments]

        # Kiểm tra tính duy nhất của expected IDs
        if len(expected_ids) != len(set(expected_ids)):
            raise NovelRebuilderError("Phát hiện trùng lặp anchorBlockId trong kết quả phân đoạn của source document.")

        # 2. Chuẩn hóa translated_blocks và kiểm tra trùng lặp supplied keys
        translation_map: Dict[str, str] = {}
        seen_supplied_keys: Set[str] = set()

        if isinstance(translated_blocks, dict):
            translation_map = dict(translated_blocks)
        elif isinstance(translated_blocks, list):
            for item in translated_blocks:
                if isinstance(item, TranslatedNovelBlock):
                    aid = item.anchor_block_id
                    txt = item.translated_text
                elif isinstance(item, dict):
                    aid = item.get("anchor_block_id") or item.get("anchorBlockId")
                    txt = item.get("translated_text") or item.get("translatedText", "")
                else:
                    raise NovelRebuilderError(f"Kiểu dữ liệu item dịch không hợp lệ: {type(item)}")

                if not aid:
                    raise NovelRebuilderError("Phát hiện item dịch thiếu anchorBlockId.")

                if aid in seen_supplied_keys:
                    raise NovelRebuilderError(f"Phát hiện anchorBlockId bị trùng lặp trong input dịch: '{aid}'.")
                seen_supplied_keys.add(aid)
                translation_map[aid] = txt

        # 3. Defense-in-depth: Kiểm tra Exact Set & Cardinality
        if not self.fallback_to_raw_on_missing:
            expected_set = set(expected_ids)
            supplied_set = set(translation_map.keys())

            extra_ids = supplied_set - expected_set
            if extra_ids:
                raise NovelRebuilderError(
                    f"Phát hiện các translated block IDs dư thừa không tồn tại trong source document: {extra_ids}."
                )

            missing_ids = expected_set - supplied_set
            if missing_ids:
                raise MissingAnchorBlockError(
                    f"Thiếu kết quả dịch cho các block bắt buộc: {missing_ids}."
                )

            if len(translation_map) != len(expected_ids):
                raise NovelRebuilderError(
                    f"Số lượng block dịch ({len(translation_map)}) không khớp số lượng block nguồn ({len(expected_ids)})."
                )

        # Hợp nhất anchor maps (ưu tiên map truyền vào, fallback sang expected_maps)
        merged_maps = dict(expected_maps)
        if anchor_maps:
            merged_maps.update(anchor_maps)

        block_counter = 0
        rebuilt_blocks: List[NovelBlockNode] = []

        for block in source_doc.blocks:
            rebuilt, block_counter = self._rebuild_block(
                block, block_counter, translation_map, merged_maps
            )
            if rebuilt:
                rebuilt_blocks.append(rebuilt)

        # Tiêu đề mới (nếu có) hoặc giữ nguyên tiêu đề gốc
        new_title = translated_title if translated_title is not None else source_doc.title

        language = target_language or source_doc.language or "vi"

        return CanonicalNovelDocument(
            blocks=rebuilt_blocks,
            title=new_title,
            language=language,
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
        strict_mode = not self.fallback_to_raw_on_missing

        if isinstance(block, HeadingBlockNode):
            current_index += 1
            block_id = f"blk_{current_index:04d}_h{block.level}"
            translated_text = translations.get(block_id)

            if translated_text is None:
                if not self.fallback_to_raw_on_missing:
                    raise MissingAnchorBlockError(f"Thiếu kết quả dịch cho Heading block '{block_id}'.")
                translated_text = block.to_plain_text()

            # Giải mã inline nodes với strict mode
            amap = anchor_maps.get(block_id, InlineAnchorMap())
            new_children = InlineAnchorCodec.decode(translated_text, amap, strict=strict_mode)

            return HeadingBlockNode(level=block.level, children=new_children), current_index

        elif isinstance(block, ParagraphBlockNode):
            current_index += 1
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
            new_children = InlineAnchorCodec.decode(translated_text, amap, strict=strict_mode)

            return ParagraphBlockNode(children=new_children), current_index

        elif isinstance(block, BlockquoteBlockNode):
            current_index += 1
            block_id = f"blk_{current_index:04d}_quote"
            translated_text = translations.get(block_id)

            if translated_text is not None:
                amap = anchor_maps.get(block_id, InlineAnchorMap())
                new_children = InlineAnchorCodec.decode(translated_text, amap, strict=strict_mode)
                return BlockquoteBlockNode(children=[ParagraphBlockNode(children=new_children)]), current_index
            else:
                sub_blocks: List[NovelBlockNode] = []
                for child in block.children:
                    rebuilt_child, current_index = self._rebuild_block(
                        child, current_index, translations, anchor_maps
                    )
                    if rebuilt_child:
                        sub_blocks.append(rebuilt_child)
                return BlockquoteBlockNode(children=sub_blocks), current_index

        elif isinstance(block, IllustrationBlockNode):
            return IllustrationBlockNode(
                src=block.src,
                alt=block.alt,
                caption=block.caption,
                width=block.width,
                height=block.height,
            ), current_index

        elif isinstance(block, DividerBlockNode):
            return DividerBlockNode(), current_index

        return None, current_index

    def rebuild_from_snapshot(
        self,
        snapshot: Union[Any, Dict[str, Any]],
        translated_blocks: Union[Dict[str, str], List[TranslatedNovelBlock], List[Dict[str, Any]]],
        translated_title: Optional[str] = None,
        target_language: Optional[str] = None,
    ) -> CanonicalNovelDocument:
        """
        Tái tạo cây CanonicalNovelDocument độc lập hoàn toàn từ NovelStructureSnapshot (#163).
        Invariant: Tuyệt đối KHÔNG gọi hoặc khởi tạo NovelSegmenter.
        Khôi phục source AST từ snapshot.document, tập hợp expected IDs từ snapshot.segments,
        và InlineAnchorMaps từ snapshot.anchorMaps.
        """
        from app.novel.structure_snapshot import snapshot_dict_to_document
        from app.novel.inline_anchors import ProtectedInlineMetadata

        # 1. Trích xuất document, segments, anchorMaps từ snapshot (hỗ trợ cả dict lẫn Pydantic model)
        if hasattr(snapshot, "document"):
            doc_data = snapshot.document
            if hasattr(doc_data, "model_dump"):
                doc_dict = doc_data.model_dump(by_alias=True)
            elif isinstance(doc_data, dict):
                doc_dict = doc_data
            else:
                doc_dict = doc_data.__dict__
            raw_segments = snapshot.segments
            raw_anchor_maps = snapshot.anchorMaps
        elif isinstance(snapshot, dict):
            doc_dict = snapshot.get("document", {})
            raw_segments = snapshot.get("segments", [])
            raw_anchor_maps = snapshot.get("anchorMaps", {})
        else:
            raise NovelRebuilderError(f"Kiểu dữ liệu snapshot không hợp lệ: {type(snapshot)}")

        source_doc = snapshot_dict_to_document(doc_dict)

        expected_ids: List[str] = []
        for seg in raw_segments:
            if hasattr(seg, "anchorBlockId"):
                expected_ids.append(seg.anchorBlockId)
            elif isinstance(seg, dict):
                expected_ids.append(seg.get("anchorBlockId") or seg.get("anchor_block_id"))
            else:
                raise NovelRebuilderError(f"Kiểu dữ liệu segment không hợp lệ: {type(seg)}")

        if len(expected_ids) != len(set(expected_ids)):
            raise NovelRebuilderError("Phát hiện trùng lặp anchorBlockId trong snapshot segments.")

        # Khôi phục InlineAnchorMaps
        reconstructed_anchor_maps: Dict[str, InlineAnchorMap] = {}
        for blk_id, entries in (raw_anchor_maps or {}).items():
            entry_map = {}
            for e in entries:
                if hasattr(e, "anchorId"):
                    tag_type = e.tagType
                    anchor_id = e.anchorId
                    ruby_text = e.rubyText
                    parenthesis_text = e.parenthesisText
                    image_src = e.imageSrc
                    image_alt = e.imageAlt
                elif isinstance(e, dict):
                    tag_type = e.get("tagType") or e.get("tag_type")
                    anchor_id = e.get("anchorId") or e.get("anchor_id")
                    ruby_text = e.get("rubyText") or e.get("ruby_text")
                    parenthesis_text = e.get("parenthesisText") or e.get("parenthesis_text")
                    image_src = e.get("imageSrc") or e.get("image_src")
                    image_alt = e.get("imageAlt") or e.get("image_alt")
                else:
                    continue
                entry_map[anchor_id] = ProtectedInlineMetadata(
                    tag_type=tag_type,
                    anchor_id=anchor_id,
                    ruby_text=ruby_text,
                    parenthesis_text=parenthesis_text,
                    image_src=image_src,
                    image_alt=image_alt,
                )
            reconstructed_anchor_maps[blk_id] = InlineAnchorMap(items=entry_map)

        # 2. Chuẩn hóa translated_blocks và kiểm tra trùng lặp supplied keys
        translation_map: Dict[str, str] = {}
        seen_supplied_keys: Set[str] = set()

        if isinstance(translated_blocks, dict):
            translation_map = dict(translated_blocks)
        elif isinstance(translated_blocks, list):
            for item in translated_blocks:
                if isinstance(item, TranslatedNovelBlock):
                    aid = item.anchor_block_id
                    txt = item.translated_text
                elif isinstance(item, dict):
                    aid = item.get("anchor_block_id") or item.get("anchorBlockId")
                    txt = item.get("translated_text") or item.get("translatedText", "")
                else:
                    raise NovelRebuilderError(f"Kiểu dữ liệu item dịch không hợp lệ: {type(item)}")

                if not aid:
                    raise NovelRebuilderError("Phát hiện item dịch thiếu anchorBlockId.")

                if aid in seen_supplied_keys:
                    raise NovelRebuilderError(f"Phát hiện anchorBlockId bị trùng lặp trong input dịch: '{aid}'.")
                seen_supplied_keys.add(aid)
                translation_map[aid] = txt

        # 3. Defense-in-depth: Kiểm tra Exact Set & Cardinality
        if not self.fallback_to_raw_on_missing:
            expected_set = set(expected_ids)
            supplied_set = set(translation_map.keys())

            extra_ids = supplied_set - expected_set
            if extra_ids:
                raise NovelRebuilderError(
                    f"Phát hiện các translated block IDs dư thừa không tồn tại trong snapshot segments: {extra_ids}."
                )

            missing_ids = expected_set - supplied_set
            if missing_ids:
                raise MissingAnchorBlockError(
                    f"Thiếu kết quả dịch cho các block bắt buộc trong snapshot: {missing_ids}."
                )

            if len(translation_map) != len(expected_ids):
                raise NovelRebuilderError(
                    f"Số lượng block dịch ({len(translation_map)}) không khớp số lượng block snapshot ({len(expected_ids)})."
                )

        # 4. Tái cấu trúc document blocks bằng expected_ids từ snapshot
        translatable_counter = 0
        rebuilt_blocks: List[NovelBlockNode] = []

        for block in source_doc.blocks:
            rebuilt, translatable_counter = self._rebuild_block_from_snapshot(
                block, translatable_counter, expected_ids, translation_map, reconstructed_anchor_maps
            )
            if rebuilt:
                rebuilt_blocks.append(rebuilt)

        new_title = translated_title if translated_title is not None else source_doc.title

        language = target_language or source_doc.language or "vi"

        return CanonicalNovelDocument(
            blocks=rebuilt_blocks,
            title=new_title,
            language=language,
            format=source_doc.format,
            metadata=copy.deepcopy(source_doc.metadata),
        )

    def _rebuild_block_from_snapshot(
        self,
        block: NovelBlockNode,
        translatable_index: int,
        expected_ids: List[str],
        translations: Dict[str, str],
        anchor_maps: Dict[str, InlineAnchorMap],
    ) -> Tuple[Optional[NovelBlockNode], int]:
        strict_mode = not self.fallback_to_raw_on_missing

        if isinstance(block, HeadingBlockNode):
            if translatable_index >= len(expected_ids):
                raise NovelRebuilderError("Index vượt quá số lượng expected_ids trong snapshot.")
            block_id = expected_ids[translatable_index]
            translatable_index += 1
            translated_text = translations.get(block_id)

            if translated_text is None:
                if not self.fallback_to_raw_on_missing:
                    raise MissingAnchorBlockError(f"Thiếu kết quả dịch cho Heading block '{block_id}'.")
                translated_text = block.to_plain_text()

            amap = anchor_maps.get(block_id, InlineAnchorMap())
            new_children = InlineAnchorCodec.decode(translated_text, amap, strict=strict_mode)
            return HeadingBlockNode(level=block.level, children=new_children), translatable_index

        elif isinstance(block, ParagraphBlockNode):
            if translatable_index >= len(expected_ids):
                raise NovelRebuilderError("Index vượt quá số lượng expected_ids trong snapshot.")
            block_id = expected_ids[translatable_index]
            translatable_index += 1
            translated_text = translations.get(block_id)

            if translated_text is None:
                if not self.fallback_to_raw_on_missing:
                    raise MissingAnchorBlockError(f"Thiếu kết quả dịch cho Paragraph block '{block_id}'.")
                translated_text = block.to_plain_text()

            amap = anchor_maps.get(block_id, InlineAnchorMap())
            new_children = InlineAnchorCodec.decode(translated_text, amap, strict=strict_mode)
            return ParagraphBlockNode(children=new_children), translatable_index

        elif isinstance(block, BlockquoteBlockNode):
            if translatable_index >= len(expected_ids):
                raise NovelRebuilderError("Index vượt quá số lượng expected_ids trong snapshot.")
            block_id = expected_ids[translatable_index]
            translatable_index += 1
            translated_text = translations.get(block_id)

            if translated_text is not None:
                amap = anchor_maps.get(block_id, InlineAnchorMap())
                new_children = InlineAnchorCodec.decode(translated_text, amap, strict=strict_mode)
                return BlockquoteBlockNode(children=[ParagraphBlockNode(children=new_children)]), translatable_index
            else:
                sub_blocks: List[NovelBlockNode] = []
                for child in block.children:
                    rebuilt_child, translatable_index = self._rebuild_block_from_snapshot(
                        child, translatable_index, expected_ids, translations, anchor_maps
                    )
                    if rebuilt_child:
                        sub_blocks.append(rebuilt_child)
                return BlockquoteBlockNode(children=sub_blocks), translatable_index

        elif isinstance(block, IllustrationBlockNode):
            return IllustrationBlockNode(
                src=block.src,
                alt=block.alt,
                caption=block.caption,
                width=block.width,
                height=block.height,
            ), translatable_index

        elif isinstance(block, DividerBlockNode):
            return DividerBlockNode(), translatable_index

        return None, translatable_index

