import pytest
from app.novel.glossary_engine import GlossaryConstraint, NovelGlossaryEngine
from app.novel.segmenter import TranslatableBlock


def test_glossary_longest_match_first():
    entries = [
        {"source_term": "魔王", "target_term": "Ma Vương", "category": "character"},
        {"source_term": "魔王の城", "target_term": "Lâu đài Ma Vương", "category": "location"},
    ]
    engine = NovelGlossaryEngine(entries)

    block = TranslatableBlock(
        anchor_block_id="blk_0001_p",
        sort_order=1,
        block_type="PARAGRAPH",
        raw_text="勇者は魔王の城へ向かった。",
    )

    matched = engine.match_blocks([block])
    assert "blk_0001_p" in matched
    constraints = matched["blk_0001_p"]
    # Longest match first: "魔王の城" must be matched first
    assert constraints[0].target_term == "Lâu đài Ma Vương"


def test_glossary_shadow_string_nfkc_preserves_raw_text():
    """
    Xác nhận Shadow String NFKC nhận diện được full-width 'ＡＢＣ' hoặc '１２３'
    trong khi raw_text của block hoàn toàn không bị mutate (100% immutable).
    """
    entries = [
        {"source_term": "ABC", "target_term": "Tổ chức ABC", "category": "org"},
        {"source_term": "第1騎士団", "target_term": "Hiệp sĩ đoàn số 1", "category": "org"},
    ]
    engine = NovelGlossaryEngine(entries)

    original_raw = "彼は ＡＢＣ の一員で、第１騎士団に所属している。"
    block = TranslatableBlock(
        anchor_block_id="blk_0002_p",
        sort_order=2,
        block_type="PARAGRAPH",
        raw_text=original_raw,
    )

    matched = engine.match_blocks([block])
    assert "blk_0002_p" in matched
    assert len(matched["blk_0002_p"]) == 2

    # Invariant: raw_text trên block không hề thay đổi
    assert block.raw_text == original_raw
    assert "ＡＢＣ" in block.raw_text


def test_glossary_empty_entries():
    engine = NovelGlossaryEngine([])
    block = TranslatableBlock(
        anchor_block_id="blk_0001_p",
        sort_order=1,
        block_type="PARAGRAPH",
        raw_text="テスト文章",
    )
    assert engine.match_blocks([block]) == {}


def test_glossary_no_matches():
    entries = [{"source_term": "ドラゴン", "target_term": "Rồng"}]
    engine = NovelGlossaryEngine(entries)
    block = TranslatableBlock(
        anchor_block_id="blk_0001_p",
        sort_order=1,
        block_type="PARAGRAPH",
        raw_text="スライムが現れた。",
    )
    assert engine.match_blocks([block]) == {}
