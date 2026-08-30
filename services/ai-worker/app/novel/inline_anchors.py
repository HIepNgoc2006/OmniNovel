from dataclasses import dataclass, field
import re
from typing import Any, Dict, List, Optional, Set, Tuple, Union

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


class InlineAnchorMismatchError(Exception):
    """Lỗi khi các thẻ protected inline tags bị mất, thừa, sai thứ tự hoặc sai kiểu dữ liệu."""
    pass


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
    - Chế độ nghiêm ngặt (Strict Mode - Mặc định): Enforce 1:1 exact set anchor IDs, reject unknown/duplicate/unclosed tags.
    - Chế độ chịu lỗi (Tolerant Mode): Chỉ dùng cho preview/fallback khi strict=False.
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
    def decode(
        cls,
        text: str,
        anchor_map: InlineAnchorMap,
        strict: bool = True,
    ) -> List[NovelInlineNode]:
        """
        Giải mã chuỗi văn bản dịch chứa protected tags thành danh sách NovelInlineNode.
        - strict=True (Mặc định cho Production): Bắt buộc khớp 100% exact set anchor IDs,
          không thiếu, không thừa, không trùng lặp, không sai kiểu tag và lồng nhau đúng chuẩn.
        - strict=False (Preview/Fallback): Tự phục hồi khi mất tag đóng.
        """
        if not text:
            return []

        pattern = re.compile(r"⟦(/?[A-Z]+):?(\d{4})?⟧")

        # 1. Nếu không có anchor nào được mong đợi
        if not anchor_map.has_anchors():
            if strict:
                found_tags = pattern.findall(text)
                if found_tags:
                    raise InlineAnchorMismatchError(
                        f"Phát hiện thẻ protected inline tag không mong đợi trong block: {found_tags}"
                    )
            cleaned_text = ANCHOR_ANY_TAG_RE.sub("", text)
            return [TextNode(cleaned_text)] if cleaned_text else []

        # 2. Strict Validation Pre-check
        if strict:
            cls._validate_strict_invariants(text, anchor_map, pattern)

        # 3. Phân tích ngữ pháp cây (Tree Parsing)
        pos = 0
        nodes: List[NovelInlineNode] = []
        stack: List[Tuple[str, str, List[NovelInlineNode]]] = []  # (tag_type, anchor_id, children)

        for match in pattern.finditer(text):
            start, end = match.span()
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
            if tag_content == "IMG":
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
                if strict:
                    # Trong strict mode, thẻ đóng bắt buộc phải khớp với thẻ trên đỉnh stack
                    if not stack:
                        raise InlineAnchorMismatchError(f"Thẻ đóng ⟦/{close_type}:{aid}⟧ không có thẻ mở tương ứng.")
                    popped_type, popped_id, children = stack.pop()
                    if popped_type != close_type or popped_id != aid:
                        raise InlineAnchorMismatchError(
                            f"Sai thứ tự lồng thẻ: mong đợi đóng ⟦/{popped_type}:{popped_id}⟧ nhưng nhận được ⟦/{close_type}:{aid}⟧."
                        )
                    meta = anchor_map.get(popped_id)
                    constructed_node = cls._construct_node(popped_type, popped_id, children, meta)
                    if constructed_node:
                        if stack:
                            stack[-1][2].append(constructed_node)
                        else:
                            nodes.append(constructed_node)
                else:
                    # Tolerant fallback
                    match_idx = -1
                    for idx in range(len(stack) - 1, -1, -1):
                        if stack[idx][0] == close_type and (not aid or stack[idx][1] == aid):
                            match_idx = idx
                            break

                    if match_idx != -1:
                        popped_type, popped_id, children = stack.pop(match_idx)
                        meta = anchor_map.get(popped_id)
                        constructed_node = cls._construct_node(popped_type, popped_id, children, meta)
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

        # Xử lý stack còn sót
        if strict and stack:
            raise InlineAnchorMismatchError(f"Thẻ ⟦{stack[-1][0]}:{stack[-1][1]}⟧ chưa được đóng.")

        while stack:
            popped_type, popped_id, children = stack.pop(0)
            meta = anchor_map.get(popped_id)
            constructed = cls._construct_node(popped_type, popped_id, children, meta)
            if constructed:
                nodes.append(constructed)
            else:
                nodes.extend(children)

        return nodes

    @classmethod
    def _validate_strict_invariants(
        cls,
        text: str,
        anchor_map: InlineAnchorMap,
        pattern: re.Pattern,
    ) -> None:
        """
        Kiểm định bất biến nghiêm ngặt của các thẻ inline:
        1. Mọi tag ID phải tồn tại trong anchor_map (Không chấp nhận Unknown ID).
        2. Mọi tag ID mở/IMG phải xuất hiện đúng 1 lần (Không Duplicate).
        3. Kiểu tag (S, E, R, IMG) phải khớp 100% với metadata đã đăng ký.
        4. Tập hợp IDs xuất hiện phải bằng chính xác tập hợp IDs trong anchor_map.
        """
        seen_open_ids: Set[str] = set()
        seen_close_ids: Set[str] = set()
        expected_ids = set(anchor_map.items.keys())

        for match in pattern.finditer(text):
            tag_content = match.group(1)
            aid = match.group(2)

            if not aid:
                raise InlineAnchorMismatchError(f"Thẻ inline không có ID hợp lệ: '{match.group(0)}'")

            if aid not in expected_ids:
                raise InlineAnchorMismatchError(
                    f"Phát hiện anchor ID lạ '{aid}' không tồn tại trong metadata của block."
                )

            meta = anchor_map.get(aid)
            assert meta is not None

            if tag_content == "IMG":
                if meta.tag_type != "IMG":
                    raise InlineAnchorMismatchError(
                        f"Sai kiểu tag cho ID '{aid}': mong đợi {meta.tag_type}, nhận được IMG."
                    )
                if aid in seen_open_ids:
                    raise InlineAnchorMismatchError(f"Anchor ID IMG '{aid}' bị xuất hiện trùng lặp nhiều lần.")
                seen_open_ids.add(aid)

            elif not tag_content.startswith("/"):
                if tag_content != meta.tag_type:
                    raise InlineAnchorMismatchError(
                        f"Sai kiểu tag mở cho ID '{aid}': mong đợi {meta.tag_type}, nhận được {tag_content}."
                    )
                if aid in seen_open_ids:
                    raise InlineAnchorMismatchError(f"Thẻ mở cho anchor ID '{aid}' bị xuất hiện trùng lặp nhiều lần.")
                seen_open_ids.add(aid)

            else:
                close_type = tag_content.lstrip("/")
                if close_type != meta.tag_type:
                    raise InlineAnchorMismatchError(
                        f"Sai kiểu tag đóng cho ID '{aid}': mong đợi /{meta.tag_type}, nhận được /{close_type}."
                    )
                if aid in seen_close_ids:
                    raise InlineAnchorMismatchError(f"Thẻ đóng cho anchor ID '{aid}' bị xuất hiện trùng lặp nhiều lần.")
                seen_close_ids.add(aid)

        # Kiểm tra exact set equality
        missing_ids = expected_ids - seen_open_ids
        if missing_ids:
            raise InlineAnchorMismatchError(
                f"Văn bản dịch bị thiếu các anchor IDs bắt buộc: {missing_ids}."
            )

        # Kiểm tra mọi thẻ mở (trừ IMG) đều có thẻ đóng
        paired_expected = {aid for aid, m in anchor_map.items.items() if m.tag_type != "IMG"}
        missing_close = paired_expected - seen_close_ids
        if missing_close:
            raise InlineAnchorMismatchError(
                f"Văn bản dịch bị thiếu thẻ đóng cho các anchor IDs: {missing_close}."
            )

    @classmethod
    def _construct_node(
        cls,
        tag_type: str,
        aid: str,
        children: List[NovelInlineNode],
        meta: Optional[ProtectedInlineMetadata],
    ) -> Optional[NovelInlineNode]:
        if tag_type == "S":
            return StrongNode(children=children)
        elif tag_type == "E":
            return EmphasisNode(children=children)
        elif tag_type == "R":
            base_text = "".join(c.to_plain_text() for c in children) if children else ""
            return RubyNode(
                base_text=base_text,
                ruby_text=meta.ruby_text if meta and meta.ruby_text else "",
                parenthesis_text=meta.parenthesis_text if meta else None,
            )
        elif tag_type == "IMG":
            return InlineImageNode(
                src=meta.image_src if meta else "",
                alt=meta.image_alt if meta else None,
            )
        return None
