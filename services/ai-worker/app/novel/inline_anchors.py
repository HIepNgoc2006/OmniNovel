from dataclasses import dataclass, field
import re
from typing import Any, Dict, List, Optional, Tuple, Union

from app.novel.ast_parser import (
    EmphasisNode,
    InlineImageNode,
    NovelInlineNode,
    RubyNode,
    StrongNode,
    TextNode,
)

# Ký tự phân cách Protected Anchor an toàn không trùng lặp văn bản thông thường
# Định dạng:
# - Strong:    ⟦S:0001⟧...⟦/S:0001⟧
# - Emphasis:  ⟦E:0002⟧...⟦/E:0002⟧
# - Ruby:      ⟦R:0003⟧...⟦/R:0003⟧
# - InlineImg: ⟦IMG:0004⟧
ANCHOR_OPEN_TAG_RE = re.compile(r"⟦([A-Z]+):(\d{4})⟧")
ANCHOR_CLOSE_TAG_RE = re.compile(r"⟦/([A-Z]+):(\d{4})⟧")
ANCHOR_ANY_TAG_RE = re.compile(r"⟦(/?[A-Z]+):?(\d{4})?⟧")


@dataclass(frozen=True)
class ProtectedInlineMetadata:
    """
    Metadata cấu trúc của một Inline Anchor được lưu trữ bảo vệ trong bộ nhớ,
    không bị gửi vào model LLM làm nhiễu ngữ cảnh dịch:
    - tag_type: 'S' (Strong), 'E' (Emphasis), 'R' (Ruby), 'IMG' (InlineImage).
    - anchor_id: Mã định danh 4 chữ số (vd: '0001').
    - ruby_text: Nội dung phiên âm furigana gốc trong thẻ <rt> (nếu là Ruby).
    - parenthesis_text: Ký tự ngoặc bổ trợ (nếu có <rp>).
    - image_src: Đường dẫn ảnh nội bộ (nếu là InlineImage).
    - image_alt: Văn bản thay thế của ảnh (nếu có).
    """
    tag_type: str
    anchor_id: str
    ruby_text: Optional[str] = None
    parenthesis_text: Optional[str] = None
    image_src: Optional[str] = None
    image_alt: Optional[str] = None


@dataclass
class InlineAnchorMap:
    """
    Bản đồ ánh xạ các Protected Inline Anchors cho một TranslatableBlock:
    - items: Dict[anchor_id, ProtectedInlineMetadata]
    """
    items: Dict[str, ProtectedInlineMetadata] = field(default_factory=dict)

    def has_anchors(self) -> bool:
        return bool(self.items)

    def get(self, anchor_id: str) -> Optional[ProtectedInlineMetadata]:
        return self.items.get(anchor_id)


class InlineAnchorCodec:
    """
    Bộ mã hóa và giải mã Protected Inline Anchors:
    - Chuyển đổi danh sách NovelInlineNode thành chuỗi văn bản chứa protected tags ⟦...⟧.
    - Giải mã chuỗi văn bản đã dịch chứa protected tags trở lại cây NovelInlineNode chuẩn xác 100%.
    - Bảo toàn nguyên vẹn furigana <rt> và image src mà không cần LLM can thiệp.
    - Chịu lỗi (Fault-tolerant): Nếu LLM làm rơi tag đóng/mở, tự động fallback an toàn không gây crash.
    """

    @classmethod
    def encode(cls, nodes: List[NovelInlineNode], start_index: int = 1) -> Tuple[str, InlineAnchorMap, int]:
        """
        Mã hóa danh sách inline nodes thành (text_with_anchors, anchor_map, next_index).
        """
        anchor_map = InlineAnchorMap()
        current_idx = start_index

        def _encode_node(node: NovelInlineNode) -> str:
            nonlocal current_idx

            if isinstance(node, TextNode):
                return node.text

            elif isinstance(node, StrongNode):
                aid = f"{current_idx:04d}"
                current_idx += 1
                anchor_map.items[aid] = ProtectedInlineMetadata(tag_type="S", anchor_id=aid)
                inner_text = "".join(_encode_node(c) for c in node.children)
                return f"⟦S:{aid}⟧{inner_text}⟦/S:{aid}⟧"

            elif isinstance(node, EmphasisNode):
                aid = f"{current_idx:04d}"
                current_idx += 1
                anchor_map.items[aid] = ProtectedInlineMetadata(tag_type="E", anchor_id=aid)
                inner_text = "".join(_encode_node(c) for c in node.children)
                return f"⟦E:{aid}⟧{inner_text}⟦/E:{aid}⟧"

            elif isinstance(node, RubyNode):
                aid = f"{current_idx:04d}"
                current_idx += 1
                anchor_map.items[aid] = ProtectedInlineMetadata(
                    tag_type="R",
                    anchor_id=aid,
                    ruby_text=node.ruby_text,
                    parenthesis_text=node.parenthesis_text,
                )
                # Chỉ đưa base_text vào trong tag để dịch, ruby_text được bảo vệ cấu trúc
                return f"⟦R:{aid}⟧{node.base_text}⟦/R:{aid}⟧"

            elif isinstance(node, InlineImageNode):
                aid = f"{current_idx:04d}"
                current_idx += 1
                anchor_map.items[aid] = ProtectedInlineMetadata(
                    tag_type="IMG",
                    anchor_id=aid,
                    image_src=node.src,
                    image_alt=node.alt,
                )
                return f"⟦IMG:{aid}⟧"

            return ""

        encoded_parts = [_encode_node(n) for n in nodes]
        return "".join(encoded_parts), anchor_map, current_idx

    @classmethod
    def decode(cls, text: str, anchor_map: InlineAnchorMap) -> List[NovelInlineNode]:
        """
        Giải mã chuỗi văn bản dịch chứa protected tags thành danh sách NovelInlineNode.
        """
        if not text:
            return []

        if not anchor_map.has_anchors():
            # Nếu không có protected anchors nào được ghi nhận, trả về TextNode đơn thuần
            # Đồng thời làm sạch mọi thẻ ⟦...⟧ rác nếu có
            cleaned_text = ANCHOR_ANY_TAG_RE.sub("", text)
            return [TextNode(cleaned_text)] if cleaned_text else []

        # Tokenize text thành các phần text thuần và tags
        tokens = ANCHOR_ANY_TAG_RE.split(text)
        # re.split với 2 capture groups trả về: [text, tag_name, anchor_id, text, ...]
        
        # Sử dụng Regex Match Scanner tuần tự để phân tích ngữ pháp cây
        pattern = re.compile(r"⟦(/?[A-Z]+):?(\d{4})?⟧")
        pos = 0
        nodes: List[NovelInlineNode] = []
        stack: List[Tuple[str, str, List[NovelInlineNode]]] = []  # (tag_type, anchor_id, children)

        for match in pattern.finditer(text):
            start, end = match.span()
            # 1. Đoạn text trước tag
            if start > pos:
                plain_piece = text[pos:start]
                if plain_piece:
                    if stack:
                        stack[-1][2].append(TextNode(plain_piece))
                    else:
                        nodes.append(TextNode(plain_piece))

            pos = end
            tag_content = match.group(1)
            aid = match.group(2) or ""

            # Tag tự đóng: Inline Image
            if tag_content == "IMG" and aid:
                meta = anchor_map.get(aid)
                img_node = InlineImageNode(
                    src=meta.image_src if meta else "",
                    alt=meta.image_alt if meta else None,
                )
                if stack:
                    stack[-1][2].append(img_node)
                else:
                    nodes.append(img_node)

            # Tag mở: Strong, Emphasis, Ruby
            elif not tag_content.startswith("/"):
                stack.append((tag_content, aid, []))

            # Tag đóng: /S, /E, /R
            else:
                close_type = tag_content.lstrip("/")
                # Tìm tag mở tương ứng trên stack
                match_idx = -1
                for idx in range(len(stack) - 1, -1, -1):
                    if stack[idx][0] == close_type and (not aid or stack[idx][1] == aid):
                        match_idx = idx
                        break

                if match_idx != -1:
                    # Pop tới match_idx
                    popped_type, popped_id, children = stack.pop(match_idx)
                    meta = anchor_map.get(popped_id)

                    constructed_node: Optional[NovelInlineNode] = None
                    if popped_type == "S":
                        constructed_node = StrongNode(children=children)
                    elif popped_type == "E":
                        constructed_node = EmphasisNode(children=children)
                    elif popped_type == "R":
                        base_text = "".join(c.to_plain_text() for c in children) if children else ""
                        constructed_node = RubyNode(
                            base_text=base_text,
                            ruby_text=meta.ruby_text if meta and meta.ruby_text else "",
                            parenthesis_text=meta.parenthesis_text if meta else None,
                        )

                    if constructed_node:
                        if stack:
                            stack[-1][2].append(constructed_node)
                        else:
                            nodes.append(constructed_node)

        # Đoạn text còn lại sau tag cuối cùng
        if pos < len(text):
            trailing_piece = text[pos:]
            if trailing_piece:
                if stack:
                    stack[-1][2].append(TextNode(trailing_piece))
                else:
                    nodes.append(TextNode(trailing_piece))

        # Nếu stack còn sót các tag mở chưa được đóng (do LLM làm mất tag đóng)
        # Flush an toàn thành TextNode hoặc node tương ứng
        while stack:
            popped_type, popped_id, children = stack.pop(0)
            meta = anchor_map.get(popped_id)
            if popped_type == "S":
                nodes.append(StrongNode(children=children))
            elif popped_type == "E":
                nodes.append(EmphasisNode(children=children))
            elif popped_type == "R":
                base_text = "".join(c.to_plain_text() for c in children) if children else ""
                nodes.append(
                    RubyNode(
                        base_text=base_text,
                        ruby_text=meta.ruby_text if meta and meta.ruby_text else "",
                        parenthesis_text=meta.parenthesis_text if meta else None,
                    )
                )
            else:
                nodes.extend(children)

        return nodes
