import pytest
from app.novel.ast_parser import (
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    ParagraphBlockNode,
    RubyNode,
    StrongNode,
    TextNode,
)
from app.novel.serializer import NovelDocumentSerializer


def test_serializer_auto_escapes_html_and_xss():
    """
    Xác nhận cơ chế Context-aware Auto-Escaping:
    Nội dung text chứa thẻ HTML nguy hiểm (<script>, onload, quotes) phải được escape an toàn.
    """
    malicious_text = "<script>alert('XSS')</script> & <b>test</b> \"quote\""
    doc = CanonicalNovelDocument(
        blocks=[
            HeadingBlockNode(level=1, children=[TextNode(malicious_text)]),
            ParagraphBlockNode(children=[TextNode("1 < 2 && 4 > 3")]),
        ],
        title="Tiêu đề <script>",
    )

    html_output = NovelDocumentSerializer.serialize_to_html(doc)

    assert "<script>" not in html_output
    assert "&lt;script&gt;alert('XSS')&lt;/script&gt;" in html_output
    assert "&lt;b&gt;test&lt;/b&gt;" in html_output
    assert "&amp;" in html_output


def test_serializer_blocks_dangerous_image_urls():
    """
    Xác nhận URL Sanitization chặn javascript: hoặc data: URI schemes.
    """
    doc = CanonicalNovelDocument(
        blocks=[
            IllustrationBlockNode(src="javascript:alert(document.cookie)", alt="XSS"),
            IllustrationBlockNode(src="assets/valid_image.webp", alt="Hợp lệ", caption="Chú thích ảnh"),
        ]
    )

    html_output = NovelDocumentSerializer.serialize_to_html(doc, include_html_wrapper=False)

    assert "javascript:" not in html_output
    assert "#unsafe-image-blocked" in html_output
    assert 'src="assets/valid_image.webp"' in html_output
    assert "<figcaption>Chú thích ảnh</figcaption>" in html_output


def test_serializer_renders_ruby_markup():
    doc = CanonicalNovelDocument(
        blocks=[
            ParagraphBlockNode(
                children=[
                    TextNode("Đây là "),
                    RubyNode(base_text="Ma Vương", ruby_text="まおう"),
                    TextNode(" vĩ đại."),
                ]
            )
        ]
    )

    html_output = NovelDocumentSerializer.serialize_to_html(doc, include_html_wrapper=False)

    assert "<ruby><rb>Ma Vương</rb><rt>まおう</rt></ruby>" in html_output
