import pytest
from app.novel.ast_parser import (
    EmphasisNode,
    InlineImageNode,
    RubyNode,
    StrongNode,
    TextNode,
)
from app.novel.inline_anchors import InlineAnchorCodec, InlineAnchorMap, ProtectedInlineMetadata


def test_encode_decode_plain_text():
    nodes = [TextNode("これは普通のテキストです。")]
    text, amap, next_idx = InlineAnchorCodec.encode(nodes)

    assert text == "これは普通のテキストです。"
    assert not amap.has_anchors()
    assert next_idx == 1

    decoded = InlineAnchorCodec.decode(text, amap)
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
    decoded = InlineAnchorCodec.decode(translated_text, amap)

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
    decoded = InlineAnchorCodec.decode(translated_text, amap)

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
    decoded = InlineAnchorCodec.decode(translated_text, amap)

    assert len(decoded) == 3
    img = decoded[1]
    assert isinstance(img, InlineImageNode)
    assert img.src == "assets/star.png"
    assert img.alt == "Ngôi sao"


def test_decoder_resilience_on_dropped_closing_tag():
    """
    Xác nhận tính chịu lỗi (Fault-tolerance):
    Khi LLM vô tình làm mất tag đóng ⟦/S:0001⟧, codec vẫn khôi phục an toàn không bị crash.
    """
    amap = InlineAnchorMap()
    amap.items["0001"] = ProtectedInlineMetadata(tag_type="S", anchor_id="0001")

    # Mất tag đóng
    broken_translated_text = "Anh ấy là ⟦S:0001⟧Dũng sĩ không có tag đóng."
    decoded = InlineAnchorCodec.decode(broken_translated_text, amap)

    assert len(decoded) >= 1
    # Vẫn khôi phục được StrongNode hoặc TextNode mà không ném Exception
    assert any(isinstance(n, StrongNode) for n in decoded) or any("Dũng sĩ" in n.to_plain_text() for n in decoded)
