from pathlib import Path
import pytest

from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    NovelAstParser,
    ParagraphBlockNode,
    TextNode,
)
from app.novel.segmenter import NovelSegmenter, SEGMENTER_VERSION, TranslatableBlock


def test_segmenter_extracts_translatable_blocks_correctly():
    doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode(text="第3章 暗雲")]),
            ParagraphBlockNode(children=[TextNode(text="雨が激しく降り始めた。")]),
            ParagraphBlockNode(children=[TextNode(text="「急いで小屋へ入ろう！」")]),
            IllustrationBlockNode(src="images/ill_rain.png"),
            DividerBlockNode(),
            BlockquoteBlockNode(children=[ParagraphBlockNode(children=[TextNode(text="古の予言が蘇る。")])]),
        ]
    )

    segmenter = NovelSegmenter()
    segments = segmenter.segment_document(doc)

    # Chỉ có 4 block có chữ (Heading, 2 Paragraphs, Blockquote)
    assert len(segments) == 4

    # 1. Heading
    assert segments[0].anchor_block_id == "blk_0001_h1"
    assert segments[0].sort_order == 1
    assert segments[0].block_type == "HEADING"
    assert segments[0].raw_text == "第3章 暗雲"
    assert segments[0].meta["heading_level"] == 1
    assert segments[0].meta["segmenter_version"] == SEGMENTER_VERSION

    # 2. Narration
    assert segments[1].anchor_block_id == "blk_0002_p"
    assert segments[1].sort_order == 2
    assert segments[1].block_type == "NARRATION"
    assert segments[1].raw_text == "雨が激しく降り始めた。"

    # 3. Dialogue
    assert segments[2].anchor_block_id == "blk_0003_dlg"
    assert segments[2].sort_order == 3
    assert segments[2].block_type == "DIALOGUE"
    assert segments[2].raw_text == "「急いで小屋へ入ろう！」"
    assert segments[2].meta["is_dialogue"] is True

    # 4. Blockquote
    assert segments[3].anchor_block_id == "blk_0004_quote"
    assert segments[3].sort_order == 4
    assert segments[3].block_type == "BLOCKQUOTE"
    assert segments[3].raw_text == "古の予言が蘇る。"


def test_segmenter_retry_determinism():
    html = """
    <h1>第1章 始まり</h1>
    <p>青い空が広がっていた。</p>
    <p>「今日はいい天気だね」</p>
    <p>『ああ、冒険日和だ』</p>
    """
    doc = NovelAstParser.parse_html(html)

    segmenter = NovelSegmenter()
    runs = [segmenter.segment_document(doc) for _ in range(5)]

    # Cả 5 lần chạy đều phải cho danh sách segments giống hệt nhau 100%
    base_run = runs[0]
    for other_run in runs[1:]:
        assert len(base_run) == len(other_run)
        for s1, s2 in zip(base_run, other_run):
            assert s1.anchor_block_id == s2.anchor_block_id
            assert s1.sort_order == s2.sort_order
            assert s1.block_type == s2.block_type
            assert s1.raw_text == s2.raw_text
            assert s1.meta == s2.meta
