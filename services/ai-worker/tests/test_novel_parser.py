from pathlib import Path
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


def test_parse_plaintext_paragraphs():
    raw_text = """
    第1章 旅立ち

    少年は静かに立ち上がった。

    「行こう、未来へ」
    """
    doc = NovelAstParser.parse_plaintext(raw_text, title="Chương 1")

    assert doc.title == "Chương 1"
    assert len(doc.blocks) == 3
    assert doc.blocks[0].to_plain_text() == "第1章 旅立ち"
    assert doc.blocks[1].to_plain_text() == "少年は静かに立ち上がった。"
    assert doc.blocks[2].to_plain_text() == "「行こう、未来へ」"


def test_parse_markdown_structures():
    md = """
# プロローグ: 運命の日

これは**重要な**段落です。

---

> 誰かが言った。「諦めるな」と。

![挿絵1](images/ill_01.png)
"""
    doc = NovelAstParser.parse_markdown(md)

    assert len(doc.blocks) == 5
    # Heading
    assert isinstance(doc.blocks[0], HeadingBlockNode)
    assert doc.blocks[0].level == 1
    assert doc.blocks[0].to_plain_text() == "プロローグ: 運命の日"

    # Paragraph
    assert isinstance(doc.blocks[1], ParagraphBlockNode)
    assert doc.blocks[1].to_plain_text() == "これは**重要な**段落です。"

    # Divider
    assert isinstance(doc.blocks[2], DividerBlockNode)

    # Blockquote
    assert doc.blocks[3].to_plain_text() == "誰かが言った。「諦めるな」と。"

    # Illustration
    assert isinstance(doc.blocks[4], IllustrationBlockNode)
    assert doc.blocks[4].src == "images/ill_01.png"
    assert doc.blocks[4].alt == "挿絵1"


def test_parse_html_with_ruby_annotations():
    html = """
    <html>
        <head><title>第2章 魔法の夜</title></head>
        <body>
            <h1>第2章 魔法の夜</h1>
            <p>見上げた<ruby><rb>夜空</rb><rp>(</rp><rt>よぞら</rt><rp>)</rp></ruby>には、星が輝いていた。</p>
            <p>彼女は<strong>微笑み</strong>を浮かべた。</p>
            <img src="images/ch2_hero.png" width="800" height="1200" alt="Heroine" />
        </body>
    </html>
    """
    doc = NovelAstParser.parse_html(html)

    assert doc.title == "第2章 魔法の夜"
    assert len(doc.blocks) == 4

    # 1. Heading
    assert isinstance(doc.blocks[0], HeadingBlockNode)
    assert doc.blocks[0].to_plain_text() == "第2章 魔法の夜"

    # 2. Paragraph with Ruby node
    p1 = doc.blocks[1]
    assert isinstance(p1, ParagraphBlockNode)
    ruby_nodes = [c for c in p1.children if isinstance(c, RubyNode)]
    assert len(ruby_nodes) == 1
    assert ruby_nodes[0].base_text == "夜空"
    assert ruby_nodes[0].ruby_text == "よぞら"
    # Plain text extraction preserves base Kanji
    assert "見上げた夜空には、星が輝いていた。" in p1.to_plain_text()

    # 3. Paragraph with Strong node
    p2 = doc.blocks[2]
    strong_nodes = [c for c in p2.children if isinstance(c, StrongNode)]
    assert len(strong_nodes) == 1

    # 4. Illustration
    img_block = doc.blocks[3]
    assert isinstance(img_block, IllustrationBlockNode)
    assert img_block.src == "images/ch2_hero.png"
    assert img_block.width == 800
    assert img_block.height == 1200


def test_parser_retry_determinism():
    html = """
    <h2>契約の儀式</h2>
    <p>「我が名は<ruby>勇者<rt>ゆうしゃ</rt></ruby>。」</p>
    <p>静寂が包み込む。</p>
    """
    doc1 = NovelAstParser.parse_html(html)
    doc2 = NovelAstParser.parse_html(html)

    assert len(doc1.blocks) == len(doc2.blocks)
    for b1, b2 in zip(doc1.blocks, doc2.blocks):
        assert type(b1) == type(b2)
        assert b1.to_plain_text() == b2.to_plain_text()


def test_parser_preserves_raw_unicode_without_nfkc_mutation():
    """
    Xác nhận parser bảo toàn 100% Unicode gốc, không tự ý biến dạng full-width,
    half-width hay compatibility forms (ví dụ: 'ＡＢＣ' không bị đổi thành 'ABC',
    '！？' không bị tách/biến đổi, '①' không bị đổi thành '1').
    """
    # 1. HTML
    html_raw = "<p>テスト ＡＢＣ １２３ ！？ ① ㌀</p>"
    doc_html = NovelAstParser.parse_html(html_raw)
    assert doc_html.blocks[0].to_plain_text() == "テスト ＡＢＣ １２３ ！？ ① ㌀"

    # 2. Plaintext
    txt_raw = "テスト ＡＢＣ １２３ ！？ ① ㌀"
    doc_txt = NovelAstParser.parse_plaintext(txt_raw)
    assert doc_txt.blocks[0].to_plain_text() == "テスト ＡＢＣ １２３ ！？ ① ㌀"

    # 3. Markdown
    md_raw = "# 見出し ＡＢＣ\n\nテスト １２３ ！？ ① ㌀"
    doc_md = NovelAstParser.parse_markdown(md_raw)
    assert doc_md.blocks[0].to_plain_text() == "見出し ＡＢＣ"
    assert doc_md.blocks[1].to_plain_text() == "テスト １２３ ！？ ① ㌀"

