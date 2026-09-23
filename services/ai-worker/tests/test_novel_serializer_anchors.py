import pytest
from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    ParagraphBlockNode,
    TextNode,
)
from app.novel.rebuilder import NovelDocumentRebuilder, NovelRebuilderError
from app.novel.segmenter import NovelSegmenter
from app.novel.serializer import NovelDocumentSerializer
from app.novel.structure_snapshot import (
    create_structure_snapshot,
    extract_source_structure_fingerprint,
)


def _build_snapshot_for_doc(doc: CanonicalNovelDocument):
    segmenter = NovelSegmenter()
    blocks, anchor_maps = segmenter.segment_document_with_inline_anchors(doc)
    source_fp = extract_source_structure_fingerprint(doc)
    return create_structure_snapshot(
        source_doc=doc,
        blocks=blocks,
        anchor_maps=anchor_maps,
        segmenter_version=segmenter.version,
        source_structure_fingerprint=source_fp,
    )


def test_mixed_document_anchor_binding_no_shift():
    """
    Acceptance test bắt buộc (#198):
    Document có cấu trúc:
    Heading -> Illustration -> Paragraph -> Divider -> Blockquote -> Paragraph

    Xác minh:
    1. Rebuilder gán chính xác từng anchor_block_id và block_type vào block tương ứng.
    2. Các khối non-translatable (Illustration, Divider) không làm dịch chuyển (shift) index của các đoạn kế tiếp.
    3. Serializer xuất chuẩn các thuộc tính data-anchor-block-id và data-block-type.
    """
    # 1. Khởi tạo Source Document
    source_blocks = [
        HeadingBlockNode(level=1, children=[TextNode(text="Chương 1: Mở Đầu")]),
        IllustrationBlockNode(src="images/hero.jpg", alt="Ảnh nhân vật chính"),
        ParagraphBlockNode(children=[TextNode(text="Trời hôm nay nhiều mây.")]),
        DividerBlockNode(),
        BlockquoteBlockNode(children=[ParagraphBlockNode(children=[TextNode(text="Lời sấm truyền ngàn năm.")])]),
        ParagraphBlockNode(children=[TextNode(text="Hắn bước tiếp về phía trước.")]),
    ]
    source_doc = CanonicalNovelDocument(
        blocks=source_blocks,
        title="Chương 1",
        language="ja",
    )

    # 2. Tạo Structure Snapshot chuẩn
    snapshot_model = _build_snapshot_for_doc(source_doc)

    # Kiểm tra snapshot chỉ chứa 4 translatable segments
    assert len(snapshot_model.segments) == 4
    assert snapshot_model.segments[0].anchorBlockId == "blk_0001_h1"
    assert snapshot_model.segments[0].blockType == "HEADING"
    assert snapshot_model.segments[1].anchorBlockId == "blk_0002_p"
    assert snapshot_model.segments[1].blockType == "NARRATION"
    assert snapshot_model.segments[2].anchorBlockId == "blk_0003_quote"
    assert snapshot_model.segments[2].blockType == "BLOCKQUOTE"
    assert snapshot_model.segments[3].anchorBlockId == "blk_0004_p"
    assert snapshot_model.segments[3].blockType == "NARRATION"

    # 3. Chuẩn bị kết quả dịch
    translations = {
        "blk_0001_h1": "Chapter 1: The Beginning",
        "blk_0002_p": "The sky was cloudy today.",
        "blk_0003_quote": "A thousand-year prophecy.",
        "blk_0004_p": "He kept walking forward.",
    }

    # 4. Rebuild document từ snapshot
    rebuilder = NovelDocumentRebuilder()
    rebuilt_doc = rebuilder.rebuild_from_snapshot(
        snapshot=snapshot_model,
        translated_blocks=translations,
        translated_title="Chapter 1",
        target_language="en",
    )

    # 5. Xác minh từng block trong cây AST
    assert len(rebuilt_doc.blocks) == 6

    # Block 0: Heading
    h_block = rebuilt_doc.blocks[0]
    assert isinstance(h_block, HeadingBlockNode)
    assert h_block.anchor_block_id == "blk_0001_h1"
    assert h_block.block_type == "HEADING"
    assert h_block.to_plain_text() == "Chapter 1: The Beginning"

    # Block 1: Illustration (Non-translatable -> KHÔNG anchor)
    ill_block = rebuilt_doc.blocks[1]
    assert isinstance(ill_block, IllustrationBlockNode)
    assert getattr(ill_block, "anchor_block_id", None) is None
    assert ill_block.src == "images/hero.jpg"

    # Block 2: Paragraph (Không bị shift bởi Illustration!)
    p1_block = rebuilt_doc.blocks[2]
    assert isinstance(p1_block, ParagraphBlockNode)
    assert p1_block.anchor_block_id == "blk_0002_p"
    assert p1_block.block_type == "NARRATION"
    assert p1_block.to_plain_text() == "The sky was cloudy today."

    # Block 3: Divider (Non-translatable -> KHÔNG anchor)
    div_block = rebuilt_doc.blocks[3]
    assert isinstance(div_block, DividerBlockNode)
    assert getattr(div_block, "anchor_block_id", None) is None

    # Block 4: Blockquote (Không bị shift bởi Divider!)
    quote_block = rebuilt_doc.blocks[4]
    assert isinstance(quote_block, BlockquoteBlockNode)
    assert quote_block.anchor_block_id == "blk_0003_quote"
    assert quote_block.block_type == "BLOCKQUOTE"

    # Block 5: Paragraph (Không bị shift bởi Blockquote!)
    p2_block = rebuilt_doc.blocks[5]
    assert isinstance(p2_block, ParagraphBlockNode)
    assert p2_block.anchor_block_id == "blk_0004_p"
    assert p2_block.block_type == "NARRATION"
    assert p2_block.to_plain_text() == "He kept walking forward."

    # 6. Serialize sang HTML và kiểm tra thuộc tính canonical
    html_output = NovelDocumentSerializer.serialize_to_html(rebuilt_doc, include_html_wrapper=False)

    # Heading có data-anchor-block-id và data-block-type
    assert '<h1 data-anchor-block-id="blk_0001_h1" data-block-type="HEADING">Chapter 1: The Beginning</h1>' in html_output

    # Illustration có <figure><img ... /></figure> và KHÔNG chứa anchor
    assert '<img src="images/hero.jpg" alt="Ảnh nhân vật chính" />' in html_output
    assert 'data-anchor-block-id' not in html_output.split('<figure>')[1].split('</figure>')[0]

    # Paragraph 1 có data-anchor-block-id và data-block-type
    assert '<p data-anchor-block-id="blk_0002_p" data-block-type="NARRATION">The sky was cloudy today.</p>' in html_output

    # Divider là <hr /> và KHÔNG chứa anchor
    assert '<hr />' in html_output

    # Blockquote có data-anchor-block-id="blk_0003_quote"
    assert '<blockquote data-anchor-block-id="blk_0003_quote" data-block-type="BLOCKQUOTE">' in html_output

    # Paragraph 2 có data-anchor-block-id và data-block-type
    assert '<p data-anchor-block-id="blk_0004_p" data-block-type="NARRATION">He kept walking forward.</p>' in html_output


def test_rebuilder_fails_closed_on_type_mismatch():
    """
    Xác minh rebuilder từ chối (fail-closed) nếu blockType trong snapshot không khớp cấu trúc AST.
    """
    source_blocks = [
        HeadingBlockNode(level=1, children=[TextNode(text="Tiêu đề")]),
    ]
    source_doc = CanonicalNovelDocument(blocks=source_blocks, title="T", language="ja")
    snapshot_model = _build_snapshot_for_doc(source_doc)

    # Giả mạo blockType thành DIALOGUE thay vì HEADING
    fake_snapshot = snapshot_model.model_dump()
    fake_snapshot["segments"][0]["blockType"] = "DIALOGUE"

    rebuilder = NovelDocumentRebuilder()
    with pytest.raises(NovelRebuilderError, match="SNAPSHOT_SEGMENT_TYPE_MISMATCH"):
        rebuilder.rebuild_from_snapshot(
            snapshot=fake_snapshot,
            translated_blocks={"blk_0001_h1": "Title"},
        )


def test_rebuilder_fails_closed_on_traversal_mismatch():
    """
    Xác minh rebuilder từ chối (fail-closed) nếu số lượng segments không khớp với số block translatable.
    """
    source_blocks = [
        ParagraphBlockNode(children=[TextNode(text="Đoạn văn 1")]),
    ]
    source_doc = CanonicalNovelDocument(blocks=source_blocks, title="T", language="ja")
    snapshot_model = _build_snapshot_for_doc(source_doc)

    # Thêm một segment dư thừa vào snapshot
    fake_snapshot = snapshot_model.model_dump()
    fake_snapshot["segments"].append({
        "anchorBlockId": "blk_0002_p",
        "blockType": "NARRATION",
        "sortOrder": 2,
    })

    rebuilder = NovelDocumentRebuilder()
    with pytest.raises(NovelRebuilderError, match="SNAPSHOT_SEGMENT_TRAVERSAL_MISMATCH"):
        rebuilder.rebuild_from_snapshot(
            snapshot=fake_snapshot,
            translated_blocks={
                "blk_0001_p": "Paragraph 1",
                "blk_0002_p": "Ghost Paragraph",
            },
        )
