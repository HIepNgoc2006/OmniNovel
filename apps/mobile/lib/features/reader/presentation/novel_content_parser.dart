import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html_parser;
import '../models/novel_block_models.dart';

/// Bộ phân tích tài liệu Novel HTML (Novel Content Parser)
///
/// **Hợp đồng kỹ thuật (#198):**
/// 1. Mobile tiêu thụ thụ động canonical anchor: Chỉ trích xuất identity từ `data-anchor-block-id`.
///    Tuyệt đối KHÔNG nhận diện generic `id="blk_..."` làm anchor để tránh va chạm.
/// 2. Fail-soft với Legacy HTML: Nếu không có `data-anchor-block-id`, đặt `anchorBlockId = null`.
/// 3. URL Sanitization: Chặn toàn bộ các scheme nguy hiểm trên ảnh: `javascript:`, `vbscript:`, và toàn bộ `data:`.
/// 4. Bảo toàn Semantic Inline Spans: Giữ cấu trúc `TextSpanItem`, `RubySpanItem`, và `InlineIllustrationItem`.
class NovelContentParser {
  static final RegExp _dangerousUrlSchemeRe =
      RegExp(r'^\s*(javascript|vbscript|data):', caseSensitive: false);

  static final RegExp _dialogueQuotesRe =
      RegExp(r'^\s*([「"“『]|—)');

  /// Phân tích chuỗi HTML thành danh sách `NovelBlockItem`
  static List<NovelBlockItem> parseHtml(String htmlContent) {
    if (htmlContent.trim().isEmpty) {
      return const [];
    }

    final document = html_parser.parse(htmlContent);
    final body = document.body;
    if (body == null) {
      return const [];
    }

    final blocks = <NovelBlockItem>[];

    for (final node in body.children) {
      final parsed = _parseBlockElement(node);
      if (parsed != null) {
        blocks.add(parsed);
      }
    }

    return blocks;
  }

  static NovelBlockItem? _parseBlockElement(dom.Element element) {
    final tagName = element.localName?.toLowerCase() ?? '';

    // Lọc bỏ các tag nguy hiểm hoặc không hiển thị
    if (tagName == 'script' || tagName == 'style' || tagName == 'iframe') {
      return null;
    }

    // 1. Trích xuất canonical anchor CHỈ từ data-anchor-block-id
    final anchorId = element.attributes['data-anchor-block-id']?.trim();
    final sanitizedAnchorId = (anchorId != null && anchorId.isNotEmpty) ? anchorId : null;

    // 2. Trích xuất blockType
    final rawBlockType = element.attributes['data-block-type']?.trim().toUpperCase();

    // Phân tích theo từng loại tag
    final headingMatch = RegExp(r'^h([1-6])$').firstMatch(tagName);
    if (headingMatch != null) {
      final level = int.parse(headingMatch.group(1)!);
      final inlineSpans = _parseInlineSpans(element);
      return NovelBlockItem(
        anchorBlockId: sanitizedAnchorId,
        blockType: NovelBlockType.heading,
        inlineSpans: inlineSpans,
        rawText: element.text.trim(),
        level: level,
      );
    }

    if (tagName == 'p') {
      final inlineSpans = _parseInlineSpans(element);
      final rawText = element.text.trim();

      NovelBlockType blockType;
      if (rawBlockType == 'DIALOGUE') {
        blockType = NovelBlockType.dialogue;
      } else if (rawBlockType == 'NARRATION') {
        blockType = NovelBlockType.narration;
      } else {
        // Suy luận an toàn từ nội dung văn bản
        blockType = _dialogueQuotesRe.hasMatch(rawText)
            ? NovelBlockType.dialogue
            : NovelBlockType.narration;
      }

      return NovelBlockItem(
        anchorBlockId: sanitizedAnchorId,
        blockType: blockType,
        inlineSpans: inlineSpans,
        rawText: rawText,
      );
    }

    if (tagName == 'blockquote') {
      final inlineSpans = _parseInlineSpans(element);
      return NovelBlockItem(
        anchorBlockId: sanitizedAnchorId,
        blockType: NovelBlockType.blockquote,
        inlineSpans: inlineSpans,
        rawText: element.text.trim(),
      );
    }

    if (tagName == 'figure') {
      final img = element.querySelector('img');
      if (img == null) return null;

      final src = _sanitizeUrl(img.attributes['src']);
      if (src == null) return null;

      final alt = img.attributes['alt']?.trim();
      final figcaption = element.querySelector('figcaption')?.text.trim();

      return NovelBlockItem(
        anchorBlockId: sanitizedAnchorId,
        blockType: NovelBlockType.illustration,
        rawText: figcaption ?? alt ?? '',
        illustrationSrc: src,
        illustrationAlt: alt,
        illustrationCaption: figcaption,
      );
    }

    if (tagName == 'img') {
      final src = _sanitizeUrl(element.attributes['src']);
      if (src == null) return null;

      final alt = element.attributes['alt']?.trim();

      return NovelBlockItem(
        anchorBlockId: sanitizedAnchorId,
        blockType: NovelBlockType.illustration,
        rawText: alt ?? '',
        illustrationSrc: src,
        illustrationAlt: alt,
      );
    }

    if (tagName == 'hr') {
      return const NovelBlockItem(
        anchorBlockId: null,
        blockType: NovelBlockType.divider,
        rawText: '',
      );
    }

    // Fallback cho thẻ generic div hoặc span có chứa text
    final text = element.text.trim();
    if (text.isNotEmpty) {
      return NovelBlockItem(
        anchorBlockId: sanitizedAnchorId,
        blockType: NovelBlockType.narration,
        inlineSpans: _parseInlineSpans(element),
        rawText: text,
      );
    }

    return null;
  }

  static List<NovelInlineSpan> _parseInlineSpans(dom.Element container) {
    final spans = <NovelInlineSpan>[];

    for (final node in container.nodes) {
      if (node is dom.Text) {
        final text = node.text;
        if (text.isNotEmpty) {
          spans.add(TextSpanItem(text: text));
        }
      } else if (node is dom.Element) {
        final tag = node.localName?.toLowerCase() ?? '';

        if (tag == 'strong' || tag == 'b') {
          spans.add(TextSpanItem(text: node.text, isBold: true));
        } else if (tag == 'em' || tag == 'i') {
          spans.add(TextSpanItem(text: node.text, isItalic: true));
        } else if (tag == 'ruby') {
          final rb = node.querySelector('rb')?.text ?? '';
          final rt = node.querySelector('rt')?.text ?? '';
          final rp = node.querySelector('rp')?.text;

          // Nếu không có thẻ <rb>, lấy text node trực tiếp trước <rt>
          final baseText = rb.isNotEmpty
              ? rb
              : node.nodes
                  .where((n) => n is dom.Text || (n is dom.Element && n.localName != 'rt' && n.localName != 'rp'))
                  .map((n) => n.text)
                  .join('')
                  .trim();

          if (baseText.isNotEmpty) {
            spans.add(
              RubySpanItem(
                baseText: baseText,
                rubyText: rt,
                parenthesisText: rp,
              ),
            );
          }
        } else if (tag == 'img') {
          final src = _sanitizeUrl(node.attributes['src']);
          if (src != null) {
            spans.add(
              InlineIllustrationItem(
                src: src,
                alt: node.attributes['alt'],
              ),
            );
          }
        } else {
          // Thẻ inline khác (span, etc.)
          spans.add(TextSpanItem(text: node.text));
        }
      }
    }

    return spans;
  }

  /// Làm sạch URL, chặn tuyệt đối javascript:, vbscript:, và toàn bộ data:
  static String? _sanitizeUrl(String? url) {
    if (url == null) return null;
    final clean = url.trim();
    if (clean.isEmpty) return null;
    if (_dangerousUrlSchemeRe.hasMatch(clean)) {
      return null;
    }
    return clean;
  }
}
