import pytest
from app.novel.ast_parser import (
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    NovelAstParser,
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
            ParagraphBlockNode(children=[TextNode("文章1")]),
            IllustrationBlockNode(src="assets/ill_01.png", alt="Minh họa 1"),
            DividerBlockNode(),
            ParagraphBlockNode(children=[TextNode("文章2")]),
        ]
    )

    # Bản dịch bảo toàn 100% cấu trúc
    translated_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("Chương 1")]),
            ParagraphBlockNode(children=[TextNode("Đoạn 1")]),
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


def test_qa_evaluator_detects_block_count_and_sequence_mismatch():
    source_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("Heading")]),
            ParagraphBlockNode(children=[TextNode("P1")]),
            ParagraphBlockNode(children=[TextNode("P2")]),
        ]
    )

    # Bản dịch bị thiếu mất 1 block paragraph
    translated_doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode("Heading Dịch")]),
            ParagraphBlockNode(children=[TextNode("P1 Dịch")]),
        ]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert result.score < 1.0
    assert any(i.rule_id == "BLOCK_COUNT_MISMATCH" for i in result.issues)


def test_qa_evaluator_detects_heading_level_mismatch():
    source_doc = CanonicalNovelDocument(
        blocks=[HeadingBlockNode(level=1, children=[TextNode("H1")])]
    )
    # Bản dịch bị hạ cấp xuống H2
    translated_doc = CanonicalNovelDocument(
        blocks=[HeadingBlockNode(level=2, children=[TextNode("H2")])]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert any(i.rule_id == "HEADING_LEVEL_MISMATCH" for i in result.issues)


def test_qa_evaluator_detects_missing_illustration():
    source_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(children=[TextNode("P1")]),
            IllustrationBlockNode(src="assets/img1.jpg"),
        ]
    )
    # Bản dịch bị mất ảnh minh họa
    translated_doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(children=[TextNode("P1")]),
        ]
    )

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert any(i.rule_id == "ILLUSTRATION_COUNT_MISMATCH" for i in result.issues)


def test_qa_evaluator_detects_illegal_control_characters():
    source_doc = CanonicalNovelDocument(blocks=[ParagraphBlockNode(children=[TextNode("Clean text")])])
    # Chứa ký tự null byte độc hại \x00
    translated_doc = CanonicalNovelDocument(blocks=[ParagraphBlockNode(children=[TextNode("Poison\x00text")])])

    evaluator = NovelStructuralQAEvaluator()
    result = evaluator.evaluate(source_doc, translated_doc)

    assert result.passed is False
    assert any(i.rule_id == "ILLEGAL_CONTROL_CHARACTERS" for i in result.issues)
