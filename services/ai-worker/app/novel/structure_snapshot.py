"""
Novel Structure Snapshot Domain Model and Canonical Serializer (#163).
Guarantees:
1. Canonical, deterministic serialization (UTF-8, sorted keys, sorted anchor entries by anchorId).
2. Explicit AST discriminators (TEXT, RUBY, STRONG, EMPHASIS, INLINE_IMAGE, HEADING, PARAGRAPH, BLOCKQUOTE, ILLUSTRATION, DIVIDER).
3. Cryptographic structural fingerprint projection and hashing (distinguished from content hash).
4. Full lossless roundtrip between AST and snapshot format.
"""

import copy
import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple, Union

from app.models.manifests import (
    NovelAnchorMapEntrySnapshotModel,
    NovelBlockType,
    NovelSegmentSnapshotModel,
    NovelStructureSnapshotModel,
)
from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    EmphasisNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    InlineImageNode,
    NovelBlockNode,
    NovelInlineNode,
    ParagraphBlockNode,
    RubyNode,
    StrongNode,
    TextNode,
)
from app.novel.inline_anchors import InlineAnchorMap, ProtectedInlineMetadata
from app.novel.qa_evaluator import NovelStructuralQAEvaluator
from app.novel.segmenter import TranslatableBlock


# ============================================================================
# AST to Snapshot Dict Conversion (Explicit Discriminators)
# ============================================================================

def inline_node_to_dict(node: NovelInlineNode) -> Dict[str, Any]:
    """Convert an inline AST node to explicit discriminator dict."""
    if isinstance(node, TextNode):
        return {"type": "TEXT", "text": node.text}
    elif isinstance(node, RubyNode):
        d: Dict[str, Any] = {
            "type": "RUBY",
            "baseText": node.base_text,
            "rubyText": node.ruby_text,
        }
        if node.parenthesis_text is not None:
            d["parenthesisText"] = node.parenthesis_text
        return d
    elif isinstance(node, StrongNode):
        return {
            "type": "STRONG",
            "children": [inline_node_to_dict(c) for c in node.children],
        }
    elif isinstance(node, EmphasisNode):
        return {
            "type": "EMPHASIS",
            "children": [inline_node_to_dict(c) for c in node.children],
        }
    elif isinstance(node, InlineImageNode):
        d = {"type": "INLINE_IMAGE", "src": node.src}
        if node.alt is not None:
            d["alt"] = node.alt
        return d
    else:
        raise ValueError(f"Unknown inline node type: {type(node)}")


def block_node_to_dict(node: NovelBlockNode) -> Dict[str, Any]:
    """Convert a block AST node to explicit discriminator dict."""
    if isinstance(node, HeadingBlockNode):
        return {
            "type": "HEADING",
            "level": node.level,
            "children": [inline_node_to_dict(c) for c in node.children],
        }
    elif isinstance(node, ParagraphBlockNode):
        return {
            "type": "PARAGRAPH",
            "children": [inline_node_to_dict(c) for c in node.children],
        }
    elif isinstance(node, BlockquoteBlockNode):
        return {
            "type": "BLOCKQUOTE",
            "children": [block_node_to_dict(c) for c in node.children],
        }
    elif isinstance(node, IllustrationBlockNode):
        d: Dict[str, Any] = {"type": "ILLUSTRATION", "src": node.src}
        if node.alt is not None:
            d["alt"] = node.alt
        if node.caption is not None:
            d["caption"] = node.caption
        if node.width is not None:
            d["width"] = node.width
        if node.height is not None:
            d["height"] = node.height
        return d
    elif isinstance(node, DividerBlockNode):
        return {"type": "DIVIDER"}
    else:
        raise ValueError(f"Unknown block node type: {type(node)}")


def document_to_snapshot_dict(doc: CanonicalNovelDocument) -> Dict[str, Any]:
    """Convert a CanonicalNovelDocument into a clean dictionary structure."""
    d: Dict[str, Any] = {
        "language": doc.language,
        "format": doc.format,
        "blocks": [block_node_to_dict(b) for b in doc.blocks],
    }
    if doc.title is not None:
        d["title"] = doc.title
    if doc.metadata:
        d["metadata"] = copy.deepcopy(doc.metadata)
    return d


# ============================================================================
# Snapshot Dict to AST Conversion
# ============================================================================

def dict_to_inline_node(data: Dict[str, Any]) -> NovelInlineNode:
    """Restore an inline AST node from snapshot dict."""
    node_type = data.get("type")
    if node_type == "TEXT":
        return TextNode(text=data.get("text", ""))
    elif node_type == "RUBY":
        return RubyNode(
            base_text=data.get("baseText", ""),
            ruby_text=data.get("rubyText", ""),
            parenthesis_text=data.get("parenthesisText"),
        )
    elif node_type == "STRONG":
        return StrongNode(
            children=[dict_to_inline_node(c) for c in data.get("children", [])]
        )
    elif node_type == "EMPHASIS":
        return EmphasisNode(
            children=[dict_to_inline_node(c) for c in data.get("children", [])]
        )
    elif node_type == "INLINE_IMAGE":
        return InlineImageNode(
            src=data.get("src", ""),
            alt=data.get("alt"),
        )
    else:
        raise ValueError(f"Unknown inline snapshot node type: {node_type}")


def dict_to_block_node(data: Dict[str, Any]) -> NovelBlockNode:
    """Restore a block AST node from snapshot dict."""
    node_type = data.get("type")
    if node_type == "HEADING":
        return HeadingBlockNode(
            level=int(data.get("level", 1)),
            children=[dict_to_inline_node(c) for c in data.get("children", [])],
        )
    elif node_type == "PARAGRAPH":
        return ParagraphBlockNode(
            children=[dict_to_inline_node(c) for c in data.get("children", [])],
        )
    elif node_type == "BLOCKQUOTE":
        return BlockquoteBlockNode(
            children=[dict_to_block_node(c) for c in data.get("children", [])],
        )
    elif node_type == "ILLUSTRATION":
        return IllustrationBlockNode(
            src=data.get("src", ""),
            alt=data.get("alt"),
            caption=data.get("caption"),
            width=data.get("width"),
            height=data.get("height"),
        )
    elif node_type == "DIVIDER":
        return DividerBlockNode()
    else:
        raise ValueError(f"Unknown block snapshot node type: {node_type}")


def snapshot_dict_to_document(doc_dict: Dict[str, Any]) -> CanonicalNovelDocument:
    """Restore a CanonicalNovelDocument from a snapshot dict."""
    blocks = [dict_to_block_node(b) for b in doc_dict.get("blocks", [])]
    return CanonicalNovelDocument(
        blocks=blocks,
        title=doc_dict.get("title"),
        language=doc_dict.get("language", "ja"),
        format=doc_dict.get("format", "html"),
        metadata=copy.deepcopy(doc_dict.get("metadata", {})),
    )


# ============================================================================
# Cryptographic Structural Fingerprint Projection & Helper
# ============================================================================

def canonicalize_source_structure_projection(doc: CanonicalNovelDocument) -> Dict[str, Any]:
    """
    Trích xuất canonical structural projection của AST tài liệu nguồn.
    Bảo toàn cấu trúc headings, paragraphs, illustrations, dividers, ruby furigana, và inline topology.
    Hoàn toàn bất biến đối với thay đổi plain text trong TextNode.
    """
    fp = NovelStructuralQAEvaluator.extract_fingerprint(doc)
    return {
        "asset_sources": sorted(fp.asset_sources),
        "block_sequence": fp.block_sequence,
        "heading_levels": fp.heading_levels,
        "inline_topology": fp.inline_topology,
        "ruby_metadata_list": [
            [r[0], r[1]] for r in fp.ruby_metadata_list
        ],
        "total_blocks": fp.total_blocks,
        "total_dividers": fp.total_dividers,
        "total_emphasis_nodes": fp.total_emphasis_nodes,
        "total_illustrations": fp.total_illustrations,
        "total_paragraphs": fp.total_paragraphs,
        "total_ruby_nodes": fp.total_ruby_nodes,
        "total_strong_nodes": fp.total_strong_nodes,
    }


def extract_source_structure_fingerprint(doc: CanonicalNovelDocument) -> str:
    """
    Tạo mã băm cryptographic fingerprint cấu trúc nguồn (format: sha256:<64hex>).
    """
    projection = canonicalize_source_structure_projection(doc)
    canonical_bytes = json.dumps(
        projection,
        sort_keys=True,
        separators=(',', ':'),
        ensure_ascii=False,
    ).encode("utf-8")
    hex_digest = hashlib.sha256(canonical_bytes).hexdigest()
    return f"sha256:{hex_digest}"


# ============================================================================
# Snapshot Creation & Canonical Serialization
# ============================================================================

def create_structure_snapshot(
    source_doc: CanonicalNovelDocument,
    blocks: List[TranslatableBlock],
    anchor_maps: Dict[str, InlineAnchorMap],
    segmenter_version: str,
    source_structure_fingerprint: str,
) -> NovelStructureSnapshotModel:
    """
    Tạo đối tượng NovelStructureSnapshotModel từ tài liệu nguồn và kết quả phân đoạn.
    """
    doc_dict = document_to_snapshot_dict(source_doc)

    segments_data: List[Dict[str, Any]] = []
    for b in blocks:
        segments_data.append({
            "anchorBlockId": b.anchor_block_id,
            "sortOrder": b.sort_order,
            "blockType": b.block_type,
        })
    # Sắp xếp segments theo sortOrder
    segments_data.sort(key=lambda s: s["sortOrder"])

    anchor_maps_data: Dict[str, List[Dict[str, Any]]] = {}
    for block_id, amap in anchor_maps.items():
        if amap.has_anchors():
            entries: List[Dict[str, Any]] = []
            for item in amap.items.values():
                entry_dict: Dict[str, Any] = {
                    "anchorId": item.anchor_id,
                    "tagType": item.tag_type,
                }
                if item.ruby_text is not None:
                    entry_dict["rubyText"] = item.ruby_text
                if item.parenthesis_text is not None:
                    entry_dict["parenthesisText"] = item.parenthesis_text
                if item.image_src is not None:
                    entry_dict["imageSrc"] = item.image_src
                if item.image_alt is not None:
                    entry_dict["imageAlt"] = item.image_alt
                entries.append(entry_dict)
            # Sắp xếp anchor entries theo anchorId
            entries.sort(key=lambda e: e["anchorId"])
            anchor_maps_data[block_id] = entries

    snapshot_data = {
        "version": 1,
        "segmenterVersion": segmenter_version,
        "sourceStructureFingerprint": source_structure_fingerprint,
        "document": doc_dict,
        "segments": segments_data,
        "anchorMaps": anchor_maps_data,
    }

    return NovelStructureSnapshotModel.model_validate(snapshot_data)


def serialize_canonical_structure_snapshot(
    snapshot: Union[NovelStructureSnapshotModel, Dict[str, Any]],
) -> Tuple[bytes, str]:
    """
    Tuần tự hóa cấu trúc snapshot thành chuỗi bytes UTF-8 chuẩn hóa tất định 100%:
    - Sắp xếp anchor entries theo anchorId.
    - Sắp xếp segments theo sortOrder.
    - json.dumps với sort_keys=True, separators=(',', ':'), ensure_ascii=False.
    Trả về Tuple[canonical_bytes, snapshotSha256_hex].
    """
    if isinstance(snapshot, NovelStructureSnapshotModel):
        data = snapshot.model_dump(mode="json", exclude_none=True)
    elif isinstance(snapshot, dict):
        data = copy.deepcopy(snapshot)
    else:
        raise ValueError(f"Expected NovelStructureSnapshotModel or dict, got {type(snapshot)}")

    # Deterministic ordering for arrays inside the snapshot
    if "segments" in data and isinstance(data["segments"], list):
        data["segments"] = sorted(data["segments"], key=lambda s: s.get("sortOrder", 0))

    if "anchorMaps" in data and isinstance(data["anchorMaps"], dict):
        for block_id, entries in data["anchorMaps"].items():
            if isinstance(entries, list):
                data["anchorMaps"][block_id] = sorted(entries, key=lambda e: e.get("anchorId", ""))

    canonical_bytes = json.dumps(
        data,
        sort_keys=True,
        separators=(',', ':'),
        ensure_ascii=False,
    ).encode("utf-8")

    snapshot_sha256 = hashlib.sha256(canonical_bytes).hexdigest()
    return canonical_bytes, snapshot_sha256
