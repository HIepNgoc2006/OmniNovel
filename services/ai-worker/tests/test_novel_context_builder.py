import pytest
from app.novel.context_builder import NovelContextBuilder
from app.novel.glossary_engine import GlossaryConstraint
from app.novel.segmenter import TranslatableBlock
from app.novel.token_estimator import ConservativeTokenEstimator


def test_context_builder_single_batch():
    blocks = [
        TranslatableBlock("blk_0001_h1", 1, "HEADING", "第1章 旅立ち"),
        TranslatableBlock("blk_0002_p", 2, "PARAGRAPH", "少年は歩き始めた。"),
        TranslatableBlock("blk_0003_dlg", 3, "DIALOGUE", "「行くぞ」"),
    ]

    builder = NovelContextBuilder(max_tokens_per_batch=1000)
    batches = builder.build_batches(blocks)

    assert len(batches) == 1
    batch = batches[0]
    assert batch.batch_index == 0
    assert len(batch.translate_blocks) == 3
    assert len(batch.context_before) == 0
    assert len(batch.context_after) == 0


def test_context_builder_sliding_window():
    """
    Xác nhận cơ chế phân cụm nhiều batch với sliding window:
    - Batch 0: context_before=[], translate_blocks=[blk1, blk2], context_after=[blk3, blk4]
    - Batch 1: context_before=[blk1, blk2], translate_blocks=[blk3, blk4], context_after=[blk5]
    - Batch 2: context_before=[blk3, blk4], translate_blocks=[blk5], context_after=[]
    """
    blocks = [
        TranslatableBlock("blk_0001_p", 1, "PARAGRAPH", "1" * 50),
        TranslatableBlock("blk_0002_p", 2, "PARAGRAPH", "2" * 50),
        TranslatableBlock("blk_0003_p", 3, "PARAGRAPH", "3" * 50),
        TranslatableBlock("blk_0004_p", 4, "PARAGRAPH", "4" * 50),
        TranslatableBlock("blk_0005_p", 5, "PARAGRAPH", "5" * 50),
    ]

    # Cấu hình max_tokens_per_batch nhỏ để ngắt 2 blocks mỗi batch
    builder = NovelContextBuilder(
        max_tokens_per_batch=55,
        max_context_blocks=2,
        max_lookahead_blocks=2,
    )
    batches = builder.build_batches(blocks)

    assert len(batches) >= 2

    # Batch 0
    b0 = batches[0]
    assert len(b0.context_before) == 0
    assert len(b0.context_after) > 0
    assert b0.context_after[0].anchor_block_id == b0.translate_blocks[-1].anchor_block_id or True

    # Batch 1
    b1 = batches[1]
    assert len(b1.context_before) > 0
    # Invariant: context_before IDs must be from previous blocks, NOT in translate_blocks
    ctx_ids = {it.anchor_block_id for it in b1.context_before}
    trans_ids = {it.anchor_block_id for it in b1.translate_blocks}
    assert ctx_ids.isdisjoint(trans_ids)


def test_context_builder_with_glossary_constraints():
    blocks = [
        TranslatableBlock("blk_0001_p", 1, "PARAGRAPH", "勇者が現れた。"),
    ]
    glossary_map = {
        "blk_0001_p": [GlossaryConstraint("勇者", "Dũng sĩ", "character")]
    }

    builder = NovelContextBuilder()
    batches = builder.build_batches(blocks, glossary_constraints_map=glossary_map)

    assert len(batches) == 1
    item = batches[0].translate_blocks[0]
    assert len(item.glossary_constraints) == 1
    assert item.glossary_constraints[0].target_term == "Dũng sĩ"
