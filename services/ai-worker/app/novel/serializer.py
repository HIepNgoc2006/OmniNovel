import html
import re
from typing import List, Optional

from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    EmphasisNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    InlineImageNode,
    NovelBlockNode,
    NovelInlineNode,
    ParagraphBlockNode,
    RubyNode,
    StrongNode,
    TextNode,
)

# Chặn các URL nguy hiểm như javascript:, vbscript:, data:text/html
DANGEROUS_URL_SCHEME_RE = re.compile(r"^\s*(javascript|vbscript|data):", re.IGNORECASE)


class NovelDocumentSerializer:
    """
    Bộ tuần tự hóa cây AST thành HTML5 chuẩn an toàn (Novel Document Serializer):
    - Context-aware HTML Auto-Escaping: Tự động escape mọi ký tự đặc biệt (&, <, >, ", ')
      cho cả TextNode và các thuộc tính HTML (alt, caption, title).
    - URL Sanitization: Chặn triệt để các URL độc hại (javascript:, data:text/html) trên thẻ <img>.
    - Cấu trúc Ruby ngữ nghĩa: Xuất thẻ <ruby><rb>...</rb><rt>...</rt></ruby> hoặc <rp> chuẩn HTML5.
    - Deterministic Output: Tạo mã HTML nhất quán, tương thích hoàn toàn với NovelAstParser.
    """

    @classmethod
    def serialize_to_html(
        cls,
        doc: CanonicalNovelDocument,
        include_html_wrapper: bool = True,
    ) -> str:
        """
        Tuần tự hóa toàn bộ CanonicalNovelDocument thành chuỗi HTML5 hoàn chỉnh hoặc HTML fragment.
        """
        body_parts: List[str] = []

        for block in doc.blocks:
            rendered = cls._render_block(block)
            if rendered:
                body_parts.append(rendered)

        inner_body = "\n".join(body_parts)

        if not include_html_wrapper:
            return inner_body

        title_text = html.escape(doc.title or "Novel Chapter", quote=True)
        lang_code = html.escape(doc.language or "vi", quote=True)

        return (
            f'<!DOCTYPE html>\n'
            f'<html lang="{lang_code}">\n'
            f'<head>\n'
            f'    <meta charset="UTF-8">\n'
            f'    <title>{title_text}</title>\n'
            f'</head>\n'
            f'<body>\n'
            f'{inner_body}\n'
            f'</body>\n'
            f'</html>'
        )

    @classmethod
    def _render_block(cls, block: NovelBlockNode) -> str:
        if isinstance(block, HeadingBlockNode):
            lvl = min(max(block.level, 1), 6)
            inner_html = "".join(cls._render_inline(c) for c in block.children)
            return f"    <h{lvl}>{inner_html}</h{lvl}>"

        elif isinstance(block, ParagraphBlockNode):
            inner_html = "".join(cls._render_inline(c) for c in block.children)
            return f"    <p>{inner_html}</p>"

        elif isinstance(block, BlockquoteBlockNode):
            sub_parts = [cls._render_block(c) for c in block.children]
            joined = "\n".join(sub_parts)
            return f"    <blockquote>\n{joined}\n    </blockquote>"

        elif isinstance(block, IllustrationBlockNode):
            safe_src = cls._sanitize_url(block.src)
            alt_attr = f' alt="{html.escape(block.alt, quote=True)}"' if block.alt else ""
            img_tag = f'<img src="{safe_src}"{alt_attr} />'

            if block.caption:
                cap_html = html.escape(block.caption, quote=True)
                return f"    <figure>\n        {img_tag}\n        <figcaption>{cap_html}</figcaption>\n    </figure>"
            return f"    <figure>{img_tag}</figure>"

        elif isinstance(block, DividerBlockNode):
            return "    <hr />"

        return ""

    @classmethod
    def _render_inline(cls, node: NovelInlineNode) -> str:
        if isinstance(node, TextNode):
            return html.escape(node.text, quote=False)

        elif isinstance(node, StrongNode):
            inner = "".join(cls._render_inline(c) for c in node.children)
            return f"<strong>{inner}</strong>"

        elif isinstance(node, EmphasisNode):
            inner = "".join(cls._render_inline(c) for c in node.children)
            return f"<em>{inner}</em>"

        elif isinstance(node, RubyNode):
            base_esc = html.escape(node.base_text, quote=False)
            rt_esc = html.escape(node.ruby_text, quote=False)
            if node.parenthesis_text:
                rp_esc = html.escape(node.parenthesis_text, quote=False)
                return f"<ruby><rb>{base_esc}</rb><rp>(</rp><rt>{rt_esc}</rt><rp>)</rp></ruby>"
            return f"<ruby><rb>{base_esc}</rb><rt>{rt_esc}</rt></ruby>"

        elif isinstance(node, InlineImageNode):
            safe_src = cls._sanitize_url(node.src)
            alt_attr = f' alt="{html.escape(node.alt, quote=True)}"' if node.alt else ""
            return f'<img src="{safe_src}"{alt_attr} />'

        return ""

    @classmethod
    def _sanitize_url(cls, url: str) -> str:
        """
        Thẩm định và làm sạch URL hình ảnh, ngăn chặn tấn công XSS qua URI scheme.
        """
        clean_url = (url or "").strip()
        if DANGEROUS_URL_SCHEME_RE.match(clean_url):
            return "#unsafe-image-blocked"
        return html.escape(clean_url, quote=True)
