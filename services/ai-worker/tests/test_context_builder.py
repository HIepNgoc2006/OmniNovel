import pytest
from app.translation.context_builder import MangaContextBuilder, MangaSegmentItem
from app.translation.glossary_engine import GlossaryEngine, GlossaryEntry


def test_segment_key_uniqueness_across_pages():
    # Page 1 sortOrder 1 vs Page 2 sortOrder 1
    segs = [
        MangaSegmentItem(page_number=1, sort_order=1, bbox_x=10, bbox_y=10, bbox_w=100, bbox_h=50, raw_text="P1-S1"),
        MangaSegmentItem(page_number=2, sort_order=1, bbox_x=10, bbox_y=10, bbox_w=100, bbox_h=50, raw_text="P2-S1"),
    ]

    builder = MangaContextBuilder()
    batches = builder.build_batches(segs)

    assert len(batches) == 1
    items = batches[0].items
    assert len(items) == 2
    # Invariant: segmentKey là duy nhất và phân biệt rõ giữa các trang
    assert items[0].segment_key == "p0001-s0001"
    assert items[1].segment_key == "p0002-s0001"
    assert items[0].segment_key != items[1].segment_key


def test_duplicate_key_rejection_fail_fast():
    # Cố tình đưa 2 segment trùng page và sortOrder
    duplicate_segs = [
        MangaSegmentItem(page_number=1, sort_order=1, bbox_x=10, bbox_y=10, bbox_w=100, bbox_h=50, raw_text="Text 1"),
        MangaSegmentItem(page_number=1, sort_order=1, bbox_x=20, bbox_y=20, bbox_w=100, bbox_h=50, raw_text="Text 2"),
    ]

    builder = MangaContextBuilder()
    with pytest.raises(ValueError, match="SEGMENT_KEY_COLLISION"):
        builder.build_batches(duplicate_segs)


def test_sliding_window_context_generation():
    segs = [
        MangaSegmentItem(page_number=1, sort_order=1, bbox_x=0, bbox_y=0, bbox_w=10, bbox_h=10, raw_text="Câu 1"),
        MangaSegmentItem(page_number=1, sort_order=2, bbox_x=0, bbox_y=0, bbox_w=10, bbox_h=10, raw_text="Câu 2"),
        MangaSegmentItem(page_number=1, sort_order=3, bbox_x=0, bbox_y=0, bbox_w=10, bbox_h=10, raw_text="Câu 3"),
        MangaSegmentItem(page_number=1, sort_order=4, bbox_x=0, bbox_y=0, bbox_w=10, bbox_h=10, raw_text="Câu 4"),
    ]

    builder = MangaContextBuilder()
    batches = builder.build_batches(segs)
    items = batches[0].items

    # Segment 3: Phải có 2 câu trước (Câu 1, Câu 2) và 1 câu sau (Câu 4)
    item3 = items[2]
    assert item3.raw_text == "Câu 3"
    assert len(item3.surrounding_context) == 3
    assert "[Trước #1]: Câu 1" in item3.surrounding_context[0]
    assert "[Trước #2]: Câu 2" in item3.surrounding_context[1]
    assert "[Sau #4]: Câu 4" in item3.surrounding_context[2]


def test_context_character_budget_and_batch_splitting():
    # Tạo 10 segments với text dài để kiểm tra cắt batch theo max_items_per_batch và max_context_chars
    segs = [
        MangaSegmentItem(
            page_number=1, sort_order=i, bbox_x=0, bbox_y=0, bbox_w=10, bbox_h=10, raw_text=f"Text dài {i} " * 20
        )
        for i in range(1, 11)
    ]

    builder = MangaContextBuilder(max_items_per_batch=3, max_context_chars=500)
    batches = builder.build_batches(segs)

    # Phải được chia thành nhiều batch nhỏ
    assert len(batches) >= 4
    for b in batches:
        assert len(b.items) <= 3
