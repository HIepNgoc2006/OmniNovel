"""
RED Unit Tests for Novel Structure Snapshot Determinism (#163).
Guarantees:
1. Deterministic canonical serialization (UTF-8, sorted keys, sorted anchor entries).
2. Structural fingerprint invariance (text changes do not affect fingerprint; structural changes do).
3. Explicit AST discriminators (no Python class names).
4. Old-Segmenter independence: rebuild_from_snapshot cannot invoke NovelSegmenter at runtime.
"""

import copy
import hashlib
import json
import pytest

from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    EmphasisNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    InlineImageNode,
    ParagraphBlockNode,
    RubyNode,
    StrongNode,
    TextNode,
)
from app.novel.inline_anchors import InlineAnchorCodec, InlineAnchorMap, ProtectedInlineMetadata
from app.novel.rebuilder import NovelDocumentRebuilder
from app.novel.segmenter import NovelSegmenter, SEGMENTER_VERSION

# Import snapshot module under test (will fail RED before implementation)
from app.novel.structure_snapshot import (
    canonicalize_source_structure_projection,
    create_structure_snapshot,
    document_to_snapshot_dict,
    extract_source_structure_fingerprint,
    serialize_canonical_structure_snapshot,
    snapshot_dict_to_document,
)


def _build_sample_novel_document() -> CanonicalNovelDocument:
    """Helper to create a rich CanonicalNovelDocument containing all node types."""
    return CanonicalNovelDocument(
        title="第1章 始まりの空",
        language="ja",
        format="html",
        metadata={"chapter_index": 1},
        blocks=[
            HeadingBlockNode(
                level=1,
                children=[
                    TextNode("第1章 "),
                    StrongNode(children=[TextNode("始まり")]),
                    TextNode("の空"),
                ],
            ),
            ParagraphBlockNode(
                children=[
                    TextNode("夜空を見上げると、"),
                    RubyNode(base_text="星屑", ruby_text="ほしくず", parenthesis_text="（ほしくず）"),
                    TextNode("が瞬いていた。"),
                    EmphasisNode(children=[TextNode("静かな夜")]),
                    TextNode("だった。"),
                ],
            ),
            IllustrationBlockNode(
                src="images/hero.png",
                alt="Hero standing under the stars",
                caption="図1: 夜空の英雄",
                width=800,
                height=600,
            ),
            ParagraphBlockNode(
                children=[
                    TextNode("「行こう、次の町へ」"),
                ],
            ),
            DividerBlockNode(),
            BlockquoteBlockNode(
                children=[
                    ParagraphBlockNode(
                        children=[
                            TextNode("古の伝承：光は闇を切り裂く。"),
                        ],
                    ),
                ],
            ),
        ],
    )


class TestNovelStructureSnapshotDeterminism:
    """Test deterministic serialization of Novel structure snapshots."""

    def test_canonical_structure_snapshot_serialization_determinism(self):
        """Invariant: Same document + segments + anchor maps produces 100% byte-for-byte identical output and SHA-256."""
        doc = _build_sample_novel_document()
        segmenter = NovelSegmenter()
        blocks, anchor_maps = segmenter.segment_document_with_inline_anchors(doc)
        source_fp = extract_source_structure_fingerprint(doc)

        snapshot1 = create_structure_snapshot(
            source_doc=doc,
            blocks=blocks,
            anchor_maps=anchor_maps,
            segmenter_version=segmenter.version,
            source_structure_fingerprint=source_fp,
        )

        snapshot2 = create_structure_snapshot(
            source_doc=doc,
            blocks=blocks,
            anchor_maps=anchor_maps,
            segmenter_version=segmenter.version,
            source_structure_fingerprint=source_fp,
        )

        bytes1, hash1 = serialize_canonical_structure_snapshot(snapshot1)
        bytes2, hash2 = serialize_canonical_structure_snapshot(snapshot2)

        assert bytes1 == bytes2
        assert hash1 == hash2
        assert len(hash1) == 64
        # Verify SHA-256 calculation matches actual bytes
        assert hashlib.sha256(bytes1).hexdigest() == hash1

    def test_canonical_serializer_sorts_anchor_map_entries_by_anchor_id(self):
        """Invariant: anchor maps within a block must have their entries deterministically sorted by anchorId."""
        doc = _build_sample_novel_document()
        segmenter = NovelSegmenter()
        blocks, anchor_maps = segmenter.segment_document_with_inline_anchors(doc)
        source_fp = extract_source_structure_fingerprint(doc)

        # Mutate anchor_maps of first block to insert out-of-order anchor IDs
        block_id = blocks[0].anchor_block_id
        unordered_map = InlineAnchorMap(
            items={
                "0002": ProtectedInlineMetadata(tag_type="E", anchor_id="0002"),
                "0001": ProtectedInlineMetadata(tag_type="S", anchor_id="0001"),
            }
        )
        anchor_maps[block_id] = unordered_map

        snapshot = create_structure_snapshot(
            source_doc=doc,
            blocks=blocks,
            anchor_maps=anchor_maps,
            segmenter_version=segmenter.version,
            source_structure_fingerprint=source_fp,
        )

        canonical_bytes, _ = serialize_canonical_structure_snapshot(snapshot)
        data = json.loads(canonical_bytes.decode("utf-8"))

        entries = data["anchorMaps"][block_id]
        anchor_ids = [e["anchorId"] for e in entries]
        assert anchor_ids == ["0001", "0002"], "Anchor entries must be sorted by anchorId"


class TestSourceStructureFingerprintInvariance:
    """Test cryptographic structural fingerprint properties."""

    def test_text_change_does_not_affect_structural_fingerprint(self):
        """Invariant: Modifying text content in TextNode does not alter sourceStructureFingerprint."""
        doc1 = _build_sample_novel_document()
        doc2 = _build_sample_novel_document()

        # Modify only the plain text content
        assert isinstance(doc2.blocks[1], ParagraphBlockNode)
        doc2.blocks[1].children[0] = TextNode("赤い夕焼けを見上げると、")
        doc2.blocks[3].children[0] = TextNode("「急ごう、夜になる前に」")

        fp1 = extract_source_structure_fingerprint(doc1)
        fp2 = extract_source_structure_fingerprint(doc2)

        assert fp1 == fp2, "Structural fingerprint must be invariant to plain text content changes"
        assert fp1.startswith("sha256:"), "Fingerprint must be prefixed with 'sha256:'"
        assert len(fp1) == 7 + 64

    def test_structural_modifications_change_fingerprint(self):
        """Invariant: Structural changes (heading level, illustrations, dividers, ruby metadata, topology) MUST change fingerprint."""
        base_doc = _build_sample_novel_document()
        base_fp = extract_source_structure_fingerprint(base_doc)

        # 1. Change heading level
        doc_heading = copy.deepcopy(base_doc)
        assert isinstance(doc_heading.blocks[0], HeadingBlockNode)
        doc_heading.blocks[0].level = 2
        assert extract_source_structure_fingerprint(doc_heading) != base_fp

        # 2. Add an illustration
        doc_ill = copy.deepcopy(base_doc)
        doc_ill.blocks.append(IllustrationBlockNode(src="images/new.png"))
        assert extract_source_structure_fingerprint(doc_ill) != base_fp

        # 3. Modify Ruby furigana text
        doc_ruby = copy.deepcopy(base_doc)
        assert isinstance(doc_ruby.blocks[1], ParagraphBlockNode)
        ruby_node = doc_ruby.blocks[1].children[1]
        assert isinstance(ruby_node, RubyNode)
        ruby_node.ruby_text = "せいしゅん"  # changed from "ほしくず"
        assert extract_source_structure_fingerprint(doc_ruby) != base_fp

        # 4. Change inline topology (e.g. wrap text in StrongNode)
        doc_topo = copy.deepcopy(base_doc)
        p = doc_topo.blocks[3]
        assert isinstance(p, ParagraphBlockNode)
        p.children = [StrongNode(children=[TextNode("「行こう、次の町へ」")])]
        assert extract_source_structure_fingerprint(doc_topo) != base_fp


class TestASTExplicitDiscriminators:
    """Test AST serialization uses explicit string discriminators, avoiding Python class names."""

    def test_ast_snapshot_uses_explicit_discriminators(self):
        doc = _build_sample_novel_document()
        doc_dict = document_to_snapshot_dict(doc)

        # Top-level blocks
        block_types = [b["type"] for b in doc_dict["blocks"]]
        expected_block_types = ["HEADING", "PARAGRAPH", "ILLUSTRATION", "PARAGRAPH", "DIVIDER", "BLOCKQUOTE"]
        assert block_types == expected_block_types

        # Check inline children discriminators
        heading_children = doc_dict["blocks"][0]["children"]
        assert [c["type"] for c in heading_children] == ["TEXT", "STRONG", "TEXT"]

        p1_children = doc_dict["blocks"][1]["children"]
        assert [c["type"] for c in p1_children] == ["TEXT", "RUBY", "TEXT", "EMPHASIS", "TEXT"]

        # Ensure no Python class names leaked into JSON
        serialized = json.dumps(doc_dict)
        assert "HeadingBlockNode" not in serialized
        assert "ParagraphBlockNode" not in serialized
        assert "RubyNode" not in serialized
        assert "TextNode" not in serialized

    def test_roundtrip_document_from_snapshot_dict(self):
        """Invariant: Document AST survives snapshot serialization roundtrip 100% losslessly."""
        doc = _build_sample_novel_document()
        doc_dict = document_to_snapshot_dict(doc)
        restored_doc = snapshot_dict_to_document(doc_dict)

        assert restored_doc.title == doc.title
        assert restored_doc.language == doc.language
        assert len(restored_doc.blocks) == len(doc.blocks)
        assert extract_source_structure_fingerprint(restored_doc) == extract_source_structure_fingerprint(doc)


class TestRebuildFromSnapshotIndependence:
    """Test that rebuild_from_snapshot operates solely on the snapshot without invoking NovelSegmenter."""

    def test_rebuild_from_snapshot_independent_of_current_segmenter(self, monkeypatch):
        """
        Invariant: rebuild_from_snapshot must NOT invoke NovelSegmenter.
        Runtime assertion: If NovelSegmenter.__init__ is called, test immediately fails.
        """
        doc = _build_sample_novel_document()
        segmenter = NovelSegmenter()
        blocks, anchor_maps = segmenter.segment_document_with_inline_anchors(doc)
        source_fp = extract_source_structure_fingerprint(doc)

        snapshot = create_structure_snapshot(
            source_doc=doc,
            blocks=blocks,
            anchor_maps=anchor_maps,
            segmenter_version=segmenter.version,
            source_structure_fingerprint=source_fp,
        )

        translated_blocks = [
            {"anchorBlockId": "blk_0001_h1", "translatedText": "Chương 1 ⟦S:0001⟧Khởi đầu⟦/S:0001⟧ bầu trời"},
            {"anchorBlockId": "blk_0002_p", "translatedText": "Ngước nhìn bầu trời đêm, ⟦R:0001⟧sao vụn⟦/R:0001⟧ lấp lánh. Đó là một ⟦E:0002⟧đêm tĩnh lặng⟦/E:0002⟧."},
            {"anchorBlockId": "blk_0003_dlg", "translatedText": "「Đi thôi, tới thị trấn tiếp theo」"},
            {"anchorBlockId": "blk_0004_quote", "translatedText": "Truyền thuyết cổ: Ánh sáng xé toạc màn đêm."},
        ]

        # Enforce that NovelSegmenter CANNOT be called
        def fail_if_segmenter_instantiated(*args, **kwargs):
            pytest.fail("FATAL: NovelSegmenter must NOT be instantiated during rebuild_from_snapshot!")

        monkeypatch.setattr(NovelSegmenter, "__init__", fail_if_segmenter_instantiated)

        rebuilder = NovelDocumentRebuilder()
        rebuilt_doc = rebuilder.rebuild_from_snapshot(
            snapshot=snapshot,
            translated_blocks=translated_blocks,
            translated_title="Chương 1 Bầu trời khởi đầu",
        )

        assert rebuilt_doc.title == "Chương 1 Bầu trời khởi đầu"
        assert rebuilt_doc.language == "vi"
        assert len(rebuilt_doc.blocks) == len(doc.blocks)
        # Verify heading children translated
        h = rebuilt_doc.blocks[0]
        assert isinstance(h, HeadingBlockNode)
        assert len(h.children) == 3
        assert h.children[0].to_plain_text() == "Chương 1 "
        assert isinstance(h.children[1], StrongNode)
        assert h.children[1].children[0].to_plain_text() == "Khởi đầu"
