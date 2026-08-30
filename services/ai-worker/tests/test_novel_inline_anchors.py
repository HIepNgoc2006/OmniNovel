import pytest
from app.novel.ast_parser import (
    EmphasisNode,
    InlineImageNode,
    RubyNode,
    StrongNode,
    TextNode,
)
from app.novel.inline_anchors import (
    InlineAnchorCodec,
    InlineAnchorMap,
    InlineAnchorMismatchError,
    ProtectedInlineMetadata,
)


def test_encode_decode_plain_text():
    nodes = [TextNode("これは普通のテキストです。")]
    text, amap, next_idx = InlineAnchorCodec.encode(nodes)

    assert text == "これは普通のテキストです。"
    assert not amap.has_anchors()
    assert next_idx == 1

    decoded = InlineAnchorCodec.decode(text, amap, strict=True)
    assert len(decoded) == 1
    assert isinstance(decoded[0], TextNode)
    assert decoded[0].text == "これは普通のテキストです。"


def test_encode_decode_strong_and_emphasis():
    nodes = [
        TextNode("彼は"),
        StrongNode([TextNode("勇者")]),
        TextNode("であり、"),
        EmphasisNode([TextNode("伝説")]),
        TextNode("の存在だ。"),
    ]
    encoded_text, amap, _ = InlineAnchorCodec.encode(nodes)

    assert "⟦S:0001⟧勇者⟦/S:0001⟧" in encoded_text
    assert "⟦E:0002⟧伝説⟦/E:0002⟧" in encoded_text
    assert amap.has_anchors()
    assert len(amap.items) == 2

    # Giả lập LLM dịch câu sang tiếng Việt giữ nguyên tags
    translated_text = "Anh ấy là ⟦S:0001⟧Dũng sĩ⟦/S:0001⟧ và là tồn tại ⟦E:0002⟧huyền thoại⟦/E:0002⟧."
    decoded = InlineAnchorCodec.decode(translated_text, amap, strict=True)

    assert len(decoded) == 5
    assert isinstance(decoded[0], TextNode) and decoded[0].text == "Anh ấy là "
    assert isinstance(decoded[1], StrongNode) and decoded[1].children[0].text == "Dũng sĩ"
    assert isinstance(decoded[2], TextNode) and decoded[2].text == " và là tồn tại "
    assert isinstance(decoded[3], EmphasisNode) and decoded[3].children[0].text == "huyền thoại"
    assert isinstance(decoded[4], TextNode) and decoded[4].text == "."


def test_encode_decode_ruby_preserves_furigana():
    """
    Xác nhận RubyNode: base_text được đưa vào tag để dịch,
    trong khi ruby_text (furigana tiếng Nhật) được bảo toàn nguyên vẹn trong metadata.
    """
    nodes = [
        TextNode("見よ、あれが"),
        RubyNode(base_text="魔王", ruby_text="まおう", parenthesis_text=None),
        TextNode("の城だ。"),
    ]
    encoded_text, amap, _ = InlineAnchorCodec.encode(nodes)

    assert "⟦R:0001⟧魔王⟦/R:0001⟧" in encoded_text
    meta = amap.get("0001")
    assert meta is not None
    assert meta.ruby_text == "まおう"

    # LLM dịch '魔王' -> 'Ma Vương'
    translated_text = "Hãy nhìn xem, đó là lâu đài của ⟦R:0001⟧Ma Vương⟦/R:0001⟧."
    decoded = InlineAnchorCodec.decode(translated_text, amap, strict=True)

    assert len(decoded) == 3
    ruby = decoded[1]
    assert isinstance(ruby, RubyNode)
    assert ruby.base_text == "Ma Vương"
    assert ruby.ruby_text == "まおう"


def test_encode_decode_inline_image():
    nodes = [
        TextNode("星マーク "),
        InlineImageNode(src="assets/star.png", alt="Ngôi sao"),
        TextNode(" が輝く。"),
    ]
    encoded_text, amap, _ = InlineAnchorCodec.encode(nodes)

    assert "⟦IMG:0001⟧" in encoded_text
    meta = amap.get("0001")
    assert meta.image_src == "assets/star.png"
    assert meta.image_alt == "Ngôi sao"

    translated_text = "Biểu tượng ngôi sao ⟦IMG:0001⟧ đang tỏa sáng."
    decoded = InlineAnchorCodec.decode(translated_text, amap, strict=True)

    assert len(decoded) == 3
    img = decoded[1]
    assert isinstance(img, InlineImageNode)
    assert img.src == "assets/star.png"
    assert img.alt == "Ngôi sao"


def test_strict_rejects_unknown_anchor_id():
    amap = InlineAnchorMap()
    amap.items["0001"] = ProtectedInlineMetadata(tag_type="S", anchor_id="0001")

    # LLM sinh ra ID lạ 0099
    bad_text = "Anh ấy là ⟦S:0099⟧Dũng sĩ⟦/S:0099⟧."
    with pytest.raises(InlineAnchorMismatchError, match="Phát hiện anchor ID lạ '0099'"):
        InlineAnchorCodec.decode(bad_text, amap, strict=True)


def test_strict_rejects_duplicate_opening_tag():
    amap = InlineAnchorMap()
    amap.items["0001"] = ProtectedInlineMetadata(tag_type="S", anchor_id="0001")

    # LLM lặp lại tag mở 0001 hai lần
    bad_text = "⟦S:0001⟧Dũng sĩ⟦/S:0001⟧ và ⟦S:0001⟧Dũng sĩ 2⟦/S:0001⟧."
    with pytest.raises(InlineAnchorMismatchError, match="bị xuất hiện trùng lặp"):
        InlineAnchorCodec.decode(bad_text, amap, strict=True)


def test_strict_rejects_tag_type_mismatch():
    amap = InlineAnchorMap()
    amap.items["0001"] = ProtectedInlineMetadata(tag_type="S", anchor_id="0001")

    # Đăng ký là S nhưng LLM dịch thành E
    bad_text = "Anh ấy là ⟦E:0001⟧Dũng sĩ⟦/E:0001⟧."
    with pytest.raises(InlineAnchorMismatchError, match="Sai kiểu tag mở cho ID '0001'"):
        InlineAnchorCodec.decode(bad_text, amap, strict=True)


def test_strict_rejects_unclosed_tag():
    amap = InlineAnchorMap()
    amap.items["0001"] = ProtectedInlineMetadata(tag_type="S", anchor_id="0001")

    # Thiếu tag đóng
    bad_text = "Anh ấy là ⟦S:0001⟧Dũng sĩ không có tag đóng."
    with pytest.raises(InlineAnchorMismatchError, match="bị thiếu thẻ đóng"):
        InlineAnchorCodec.decode(bad_text, amap, strict=True)


def test_strict_rejects_improper_nesting_interleaving():
    amap = InlineAnchorMap()
    amap.items["0001"] = ProtectedInlineMetadata(tag_type="S", anchor_id="0001")
    amap.items["0002"] = ProtectedInlineMetadata(tag_type="E", anchor_id="0002")

    # Cắt chéo tag: S mở -> E mở -> S đóng -> E đóng
    bad_text = "⟦S:0001⟧Dũng sĩ ⟦E:0002⟧Huyền thoại⟦/S:0001⟧⟦/E:0002⟧"
    with pytest.raises(InlineAnchorMismatchError, match="Sai thứ tự lồng thẻ"):
        InlineAnchorCodec.decode(bad_text, amap, strict=True)


def test_strict_rejects_unexpected_tags_when_no_anchors():
    amap = InlineAnchorMap()
    bad_text = "Văn bản này tự dưng có ⟦S:0001⟧tag lạ⟦/S:0001⟧."
    with pytest.raises(InlineAnchorMismatchError, match="Phát hiện thẻ protected inline tag không mong đợi"):
        InlineAnchorCodec.decode(bad_text, amap, strict=True)


def test_decoder_resilience_in_tolerant_mode():
    """
    Xác nhận tính chịu lỗi khi strict=False (dành cho Preview/Fallback).
    """
    amap = InlineAnchorMap()
    amap.items["0001"] = ProtectedInlineMetadata(tag_type="S", anchor_id="0001")

    broken_text = "Anh ấy là ⟦S:0001⟧Dũng sĩ không có tag đóng."
    decoded = InlineAnchorCodec.decode(broken_text, amap, strict=False)

    assert len(decoded) >= 1
    assert any(isinstance(n, StrongNode) for n in decoded) or any("Dũng sĩ" in n.to_plain_text() for n in decoded)
