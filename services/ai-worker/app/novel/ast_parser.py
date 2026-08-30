from abc import ABC
from dataclasses import dataclass, field
from html.parser import HTMLParser
import re
from typing import Any, Dict, List, Optional, Union


# ============================================================================
# AST Node Hierarchy
# ============================================================================

class NovelNode(ABC):
    """Lớp cơ sở cho toàn bộ các node trong Canonical Document AST."""
    pass


# --- Inline Nodes ---

class NovelInlineNode(NovelNode):
    """Node cấp độ dòng (Inline)."""
    pass


@dataclass
class TextNode(NovelInlineNode):
    text: str

    def to_plain_text(self) -> str:
        return self.text


@dataclass
class RubyNode(NovelInlineNode):
    """
    Node phiên âm tiếng Nhật: <ruby>base_text<rt>ruby_text</rt></ruby>.
    Ví dụ: <ruby>夜空<rt>よぞら</rt></ruby> -> base_text='夜空', ruby_text='よぞら'.
    """
    base_text: str
    ruby_text: str
    parenthesis_text: Optional[str] = None

    def to_plain_text(self) -> str:
        # Khi trích xuất plain text để dịch, lấy base_text (chữ Hán/gốc)
        return self.base_text


@dataclass
class EmphasisNode(NovelInlineNode):
    children: List[NovelInlineNode] = field(default_factory=list)

    def to_plain_text(self) -> str:
        return "".join(c.to_plain_text() for c in self.children)


@dataclass
class StrongNode(NovelInlineNode):
    children: List[NovelInlineNode] = field(default_factory=list)

    def to_plain_text(self) -> str:
        return "".join(c.to_plain_text() for c in self.children)


@dataclass
class InlineImageNode(NovelInlineNode):
    src: str
    alt: Optional[str] = None

    def to_plain_text(self) -> str:
        return ""


# --- Block Nodes ---

class NovelBlockNode(NovelNode):
    """Node cấp độ khối (Block)."""
    pass


@dataclass
class HeadingBlockNode(NovelBlockNode):
    level: int  # 1 to 6
    children: List[NovelInlineNode] = field(default_factory=list)

    def to_plain_text(self) -> str:
        return "".join(c.to_plain_text() for c in self.children).strip()


@dataclass
class ParagraphBlockNode(NovelBlockNode):
    children: List[NovelInlineNode] = field(default_factory=list)

    def to_plain_text(self) -> str:
        return "".join(c.to_plain_text() for c in self.children).strip()


@dataclass
class BlockquoteBlockNode(NovelBlockNode):
    children: List[NovelBlockNode] = field(default_factory=list)

    def to_plain_text(self) -> str:
        return "\n".join(c.to_plain_text() for c in self.children).strip()


@dataclass
class IllustrationBlockNode(NovelBlockNode):
    src: str
    alt: Optional[str] = None
    caption: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None

    def to_plain_text(self) -> str:
        return ""


@dataclass
class DividerBlockNode(NovelBlockNode):
    """Thẻ phân đoạn <hr />."""
    def to_plain_text(self) -> str:
        return ""


# --- Document Root ---

@dataclass
class CanonicalNovelDocument:
    """
    Cây Document AST chuẩn hóa bất biến cho toàn bộ chương tiểu thuyết:
    - Độc lập với format nguồn (.md, .txt, .html, .epub).
    - Bảo toàn 100% cấu trúc thẻ, quan hệ cha-con và vị trí ảnh minh họa.
    """
    blocks: List[NovelBlockNode] = field(default_factory=list)
    title: Optional[str] = None
    language: str = "ja"
    format: str = "html"
    metadata: Dict[str, Any] = field(default_factory=dict)


# ============================================================================
# HTML DOM to AST Parser
# ============================================================================

class _HtmlToAstParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.blocks: List[NovelBlockNode] = []
        self.title: Optional[str] = None

        # Tracking state
        self._current_block: Optional[Union[HeadingBlockNode, ParagraphBlockNode, BlockquoteBlockNode]] = None
        self._in_title = False
        self._ruby_state: Optional[Dict[str, str]] = None
        self._inline_stack: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[tuple]):
        tag = tag.lower()
        attr_dict = {k.lower(): v for k, v in attrs}

        if tag == "title":
            self._in_title = True

        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag[1])
            self._current_block = HeadingBlockNode(level=level)

        elif tag == "p":
            self._current_block = ParagraphBlockNode()

        elif tag == "blockquote":
            self._current_block = BlockquoteBlockNode()

        elif tag in ("hr", "divider"):
            self.blocks.append(DividerBlockNode())

        elif tag == "img":
            src = attr_dict.get("src", "")
            alt = attr_dict.get("alt")
            width = int(attr_dict["width"]) if attr_dict.get("width", "").isdigit() else None
            height = int(attr_dict["height"]) if attr_dict.get("height", "").isdigit() else None

            if self._current_block is not None:
                # Nếu ảnh nằm trong paragraph, thêm inline node
                self._current_block.children.append(InlineImageNode(src=src, alt=alt))
            else:
                self.blocks.append(IllustrationBlockNode(src=src, alt=alt, width=width, height=height))

        elif tag == "ruby":
            self._ruby_state = {"base": "", "rt": "", "rp": "", "current_part": "base"}

        elif tag in ("rb", "rbc"):
            if self._ruby_state:
                self._ruby_state["current_part"] = "base"

        elif tag == "rt":
            if self._ruby_state:
                self._ruby_state["current_part"] = "rt"

        elif tag == "rp":
            if self._ruby_state:
                self._ruby_state["current_part"] = "rp"

        elif tag in ("strong", "b"):
            self._inline_stack.append(tag)

        elif tag in ("em", "i"):
            self._inline_stack.append(tag)

    def handle_endtag(self, tag: str):
        tag = tag.lower()

        if tag == "title":
            self._in_title = False

        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote"):
            if self._current_block is not None:
                # Chỉ giữ lại block nếu có nội dung hoặc có inline nodes
                if len(self._current_block.children) > 0 or self._current_block.to_plain_text():
                    self.blocks.append(self._current_block)
                self._current_block = None

        elif tag == "ruby":
            if self._ruby_state and self._current_block is not None:
                ruby_node = RubyNode(
                    base_text=self._ruby_state.get("base", "").strip(),
                    ruby_text=self._ruby_state.get("rt", "").strip(),
                    parenthesis_text=self._ruby_state.get("rp", "").strip() or None,
                )
                self._current_block.children.append(ruby_node)
            self._ruby_state = None

        elif tag in ("strong", "b", "em", "i"):
            if self._inline_stack and self._inline_stack[-1] == tag:
                self._inline_stack.pop()

    def handle_data(self, data: str):
        if self._in_title:
            self.title = (self.title or "") + data
            return

        if self._ruby_state is not None:
            part = self._ruby_state.get("current_part", "base")
            self._ruby_state[part] = self._ruby_state.get(part, "") + data
            return

        if self._current_block is not None:
            if not data:
                return

            if "strong" in self._inline_stack or "b" in self._inline_stack:
                self._current_block.children.append(StrongNode(children=[TextNode(text=data)]))
            elif "em" in self._inline_stack or "i" in self._inline_stack:
                self._current_block.children.append(EmphasisNode(children=[TextNode(text=data)]))
            else:
                self._current_block.children.append(TextNode(text=data))
        else:
            # Văn bản tự do ngoài thẻ block -> tự động tạo ParagraphBlockNode nếu không chỉ là whitespace
            stripped = data.strip()
            if stripped:
                p = ParagraphBlockNode(children=[TextNode(text=stripped)])
                self.blocks.append(p)


# ============================================================================
# Novel AST Parser Engine
# ============================================================================

class NovelAstParser:
    """
    Parser đa định dạng (HTML, XHTML, Markdown, Plain Text) sang Canonical Document AST.
    Bảo toàn nguyên dạng ký tự Unicode (không áp dụng NFKC compatibility transformation, bảo toàn codepoint gốc).
    """

    @classmethod
    def parse_html(cls, html_content: str, title: Optional[str] = None, language: str = "ja") -> CanonicalNovelDocument:
        parser = _HtmlToAstParser()
        parser.feed(html_content)
        parser.close()

        doc_title = title or (parser.title.strip() if parser.title else None)

        return CanonicalNovelDocument(
            blocks=parser.blocks,
            title=doc_title,
            language=language,
            format="html",
        )

    @classmethod
    def parse_plaintext(cls, text_content: str, title: Optional[str] = None, language: str = "ja") -> CanonicalNovelDocument:
        raw_paragraphs = re.split(r"\n\s*\n", text_content.strip())
        blocks: List[NovelBlockNode] = []

        for p_str in raw_paragraphs:
            cleaned = p_str.strip()
            if cleaned:
                blocks.append(ParagraphBlockNode(children=[TextNode(text=cleaned)]))

        return CanonicalNovelDocument(
            blocks=blocks,
            title=title,
            language=language,
            format="plaintext",
        )

    @classmethod
    def parse_markdown(cls, md_content: str, title: Optional[str] = None, language: str = "ja") -> CanonicalNovelDocument:
        blocks: List[NovelBlockNode] = []
        lines = md_content.splitlines()

        current_para_lines: List[str] = []

        def flush_para():
            if current_para_lines:
                full_text = " ".join(current_para_lines).strip()
                if full_text:
                    blocks.append(ParagraphBlockNode(children=[TextNode(text=full_text)]))
                current_para_lines.clear()

        for line in lines:
            line_str = line.strip()
            if not line_str:
                flush_para()
                continue

            # Heading (# ...)
            heading_match = re.match(r"^(#{1,6})\s+(.*)$", line_str)
            if heading_match:
                flush_para()
                level = len(heading_match.group(1))
                h_text = heading_match.group(2).strip()
                blocks.append(HeadingBlockNode(level=level, children=[TextNode(text=h_text)]))
                continue

            # Divider (--- / ***)
            if re.match(r"^(\-{3,}|\*{3,}|_{3,})$", line_str):
                flush_para()
                blocks.append(DividerBlockNode())
                continue

            # Blockquote (> ...)
            if line_str.startswith(">"):
                flush_para()
                quote_text = line_str.lstrip(">").strip()
                blocks.append(BlockquoteBlockNode(children=[ParagraphBlockNode(children=[TextNode(text=quote_text)])]))
                continue

            # Illustration (![alt](src))
            img_match = re.match(r"^!\[(.*?)\]\((.*?)\)$", line_str)
            if img_match:
                flush_para()
                alt_txt = img_match.group(1).strip() or None
                src_txt = img_match.group(2).strip()
                blocks.append(IllustrationBlockNode(src=src_txt, alt=alt_txt))
                continue

            current_para_lines.append(line_str)

        flush_para()

        return CanonicalNovelDocument(
            blocks=blocks,
            title=title,
            language=language,
            format="markdown",
        )
