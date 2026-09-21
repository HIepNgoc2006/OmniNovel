import pytest
from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    ParagraphBlockNode,
    RubyNode,
    StrongNode,
    TextNode,
)
from app.novel.inline_anchors import (
    InlineAnchorCodec,
    InlineAnchorMismatchError,
)
from app.novel.rebuilder import (
    MissingAnchorBlockError,
    NovelDocumentRebuilder,
    NovelRebuilderError,
)
from app.novel.segmenter import NovelSegmenter


def test_rebuilder_source_immutability():
    """
    Xác nhận Invariant 1: Source AST hoàn toàn bất biến (không bị mutate khi rebuild).
    """
    source_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("第1章 旅立ち")]),
            ParagraphBlockNode(children=[TextNode("少年は歩き始めた。")]),
        ],
        title="第1章",
        language="ja",
    )

    segmenter = NovelSegmenter()
    blocks, amaps = segmenter.segment_document_with_inline_anchors(source_doc)

    translations = {
        "blk_0001_h1": "Chương 1 Khởi hành",
        "blk_0002_p": "Cậu thiếu niên bắt đầu cất bước.",
    }

    rebuilder = NovelDocumentRebuilder()
    rebuilt_doc = rebuilder.rebuild(
        source_doc,
        translations,
        amaps,
        translated_title="Chương 1",
        target_language="vi",
    )

    # Invariant: source_doc không bị thay đổi
    assert source_doc.language == "ja"
    assert source_doc.title == "第1章"
    assert source_doc.blocks[0].children[0].text == "第1章 旅立ち"

    # rebuilt_doc có dữ liệu mới
    assert rebuilt_doc.language == "vi"
    assert rebuilt_doc.title == "Chương 1"
    assert rebuilt_doc.blocks[0].children[0].text == "Chương 1 Khởi hành"
    assert rebuilt_doc.blocks[1].children[0].text == "Cậu thiếu niên bắt đầu cất bước."


def test_rebuilder_preserves_inline_ruby_and_strong():
    source_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    TextNode("彼は"),
                    StrongNode([TextNode("勇者")]),
                    TextNode("と"),
                    RubyNode(base_text="魔王", ruby_text="まおう"),
                    TextNode("を見た。"),
                ]
            )
        ]
    )

    segmenter = NovelSegmenter()
    blocks, amaps = segmenter.segment_document_with_inline_anchors(source_doc)

    assert "⟦S:0001⟧勇者⟦/S:0001⟧" in blocks[0].raw_text
    assert "⟦R:0002⟧魔王⟦/R:0002⟧" in blocks[0].raw_text

    translations = {
        "blk_0001_p": "Anh ấy nhìn thấy ⟦S:0001⟧Dũng sĩ⟦/S:0001⟧ và ⟦R:0002⟧Ma Vương⟦/R:0002⟧."
    }

    rebuilder = NovelDocumentRebuilder()
    rebuilt_doc = rebuilder.rebuild(source_doc, translations, amaps)

    p_node = rebuilt_doc.blocks[0]
    assert isinstance(p_node, ParagraphBlockNode)
    assert len(p_node.children) == 5

    # Check StrongNode
    assert isinstance(p_node.children[1], StrongNode)
    assert p_node.children[1].children[0].text == "Dũng sĩ"

    # Check RubyNode
    ruby = p_node.children[3]
    assert isinstance(ruby, RubyNode)
    assert ruby.base_text == "Ma Vương"
    assert ruby.ruby_text == "まおう"


def test_rebuilder_preserves_structural_nodes():
    source_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("Tiêu đề")]),
            IllustrationBlockNode(src="assets/ill_01.png", alt="Minh họa 1", caption="Cảnh chiến đấu"),
            DividerBlockNode(),
            ParagraphBlockNode(children=[TextNode("Nội dung sau vạch ngăn.")]),
        ]
    )

    translations = {
        "blk_0001_h1": "Tiêu đề dịch",
        "blk_0002_p": "Nội dung dịch",
    }

    rebuilder = NovelDocumentRebuilder()
    rebuilt_doc = rebuilder.rebuild(source_doc, translations)

    assert len(rebuilt_doc.blocks) == 4
    # Illustration block preserved
    assert isinstance(rebuilt_doc.blocks[1], IllustrationBlockNode)
    assert rebuilt_doc.blocks[1].src == "assets/ill_01.png"
    assert rebuilt_doc.blocks[1].alt == "Minh họa 1"
    assert rebuilt_doc.blocks[1].caption == "Cảnh chiến đấu"

    # Divider block preserved
    assert isinstance(rebuilt_doc.blocks[2], DividerBlockNode)


def test_rebuilder_missing_anchor_block_raises_error():
    source_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("Heading 1")]),
            ParagraphBlockNode(children=[TextNode("Paragraph 1")]),
        ]
    )

    # Thiếu kết quả cho blk_0002_p
    translations = {"blk_0001_h1": "Heading 1 Dịch"}
    rebuilder = NovelDocumentRebuilder(fallback_to_raw_on_missing=False)

    with pytest.raises(MissingAnchorBlockError, match="Thiếu kết quả dịch cho các block bắt buộc"):
        rebuilder.rebuild(source_doc, translations)


def test_rebuilder_rejects_extra_translated_blocks():
    source_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("Heading 1")]),
        ]
    )

    # Dư thừa kết quả cho blk_0099_p
    translations = {
        "blk_0001_h1": "Heading 1 Dịch",
        "blk_0099_p": "Extra translated block",
    }
    rebuilder = NovelDocumentRebuilder(fallback_to_raw_on_missing=False)

    with pytest.raises(NovelRebuilderError, match="Phát hiện các translated block IDs dư thừa"):
        rebuilder.rebuild(source_doc, translations)


def test_rebuilder_rejects_duplicate_anchor_blocks_in_list():
    source_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("Heading 1")]),
        ]
    )

    translations = [
        {"anchorBlockId": "blk_0001_h1", "translatedText": "Heading 1 Bản A"},
        {"anchorBlockId": "blk_0001_h1", "translatedText": "Heading 1 Bản B"},
    ]
    rebuilder = NovelDocumentRebuilder(fallback_to_raw_on_missing=False)

    with pytest.raises(NovelRebuilderError, match="bị trùng lặp trong input dịch"):
        rebuilder.rebuild(source_doc, translations)


def test_rebuilder_enforces_strict_inline_anchor_mismatch():
    source_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    TextNode("彼は"),
                    StrongNode([TextNode("勇者")]),
                    TextNode("だ。"),
                ]
            )
        ]
    )

    # LLM làm mất thẻ đóng ⟦/S:0001⟧
    translations = {
        "blk_0001_p": "Anh ấy là ⟦S:0001⟧Dũng sĩ không có tag đóng.",
    }
    rebuilder = NovelDocumentRebuilder(fallback_to_raw_on_missing=False)

    with pytest.raises(InlineAnchorMismatchError):
        rebuilder.rebuild(source_doc, translations)
