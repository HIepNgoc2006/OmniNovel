import pytest
from app.novel.ast_parser import (
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
from app.novel.qa_evaluator import NovelStructuralQAEvaluator, QASeverity


def test_qa_evaluator_perfect_match():
    source_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("第1章")]),
            ParagraphBlockNode(
                children=[
                    TextNode("彼らは"),
                    StrongNode([TextNode("勇者")]),
                    TextNode("と"),
                    RubyNode(base_text="魔王", ruby_text="まおう"),
                    TextNode("と"),
                    EmphasisNode([TextNode("伝説")]),
                    TextNode("を見た。"),
                ]
            ),
            IllustrationBlockNode(src="assets/ill_01.png", alt="Minh họa 1"),
            DividerBlockNode(),
            ParagraphBlockNode(children=[TextNode("文章2")]),
        ]
    )

    # Bản dịch bảo toàn 100% cấu trúc và metadata
    translated_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("Chương 1")]),
            ParagraphBlockNode(
                children=[
                    TextNode("Bọn họ thấy "),
                    StrongNode([TextNode("Dũng sĩ")]),
                    TextNode(" cùng "),
                    RubyNode(base_text="Ma Vương", ruby_text="まおう"),
                    TextNode(" và "),
                    EmphasisNode([TextNode("huyền thoại")]),
                    TextNode("."),
                ]
            ),
            IllustrationBlockNode(src="assets/ill_01.png", alt="Minh họa 1"),
            DividerBlockNode(),
            ParagraphBlockNode(children=[TextNode("Đoạn 2")]),
        ]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is True
    assert result.score == 1.0
    assert result.fingerprint_match is True
    assert len(result.issues) == 0


def test_qa_evaluator_detects_ruby_furigana_mutation():
    """
    Xác nhận phát hiện lỗi khi furigana trong thẻ <rt> bị sửa đổi hoặc biến dạng.
    """
    source_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    RubyNode(base_text="魔王", ruby_text="まおう"),
                ]
            )
        ]
    )

    # Furigana gốc 'まおう' bị đổi thành 'devildom'
    translated_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    RubyNode(base_text="Ma Vương", ruby_text="devildom"),
                ]
            )
        ]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert result.fingerprint_match is False
    assert any(i.rule_id == "RUBY_METADATA_MUTATED" for i in result.issues)


def test_qa_evaluator_detects_missing_emphasis():
    source_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    TextNode("Đây là "),
                    EmphasisNode([TextNode("nhấn mạnh")]),
                ]
            )
        ]
    )

    # Bản dịch làm mất thẻ Emphasis
    translated_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    TextNode("Đây là nhấn mạnh"),
                ]
            )
        ]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert any(i.rule_id == "EMPHASIS_COUNT_MISMATCH" for i in result.issues)


def test_qa_evaluator_detects_missing_divider():
    source_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(children=[TextNode("P1")]),
            DividerBlockNode(),
            ParagraphBlockNode(children=[TextNode("P2")]),
        ]
    )

    # Bản dịch làm mất thẻ Divider <hr />
    translated_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(children=[TextNode("P1")]),
            ParagraphBlockNode(children=[TextNode("P2")]),
        ]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert any(i.rule_id == "DIVIDER_COUNT_MISMATCH" for i in result.issues)


def test_qa_evaluator_detects_inline_topology_mismatch():
    """
    Xác nhận phát hiện khi thứ tự hoặc cấp độ lồng nhau của inline tags bị đảo lộn.
    """
    source_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    StrongNode([TextNode("In đậm")]),
                    EmphasisNode([TextNode("In nghiêng")]),
                ]
            )
        ]
    )

    # Đảo lộn thứ tự: Emphasis trước, Strong sau
    translated_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    EmphasisNode([TextNode("In nghiêng")]),
                    StrongNode([TextNode("In đậm")]),
                ]
            )
        ]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert any(i.rule_id == "INLINE_TOPOLOGY_MISMATCH" for i in result.issues)


def test_qa_evaluator_detects_changed_inline_image_src():
    source_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    InlineImageNode(src="assets/orig_star.png"),
                ]
            )
        ]
    )

    # URI ảnh bị đổi sang link khác
    translated_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    InlineImageNode(src="assets/hacked_star.png"),
                ]
            )
        ]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert any(i.rule_id == "ASSET_SOURCE_MISMATCH" for i in result.issues)


def test_qa_evaluator_detects_illegal_control_characters():
    source_doc = CanonicalNovelDocument(blocks=[ParagraphBlockNode(children=[TextNode("Clean text")])])
    # Chứa ký tự null byte độc hại \x00
    translated_doc = CanonicalNovelDocument(blocks=[ParagraphBlockNode(children=[TextNode("Poison\x00text")])])

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert any(i.rule_id == "ILLEGAL_CONTROL_CHARACTERS" for i in result.issues)
