import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/features/reader/models/novel_block_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/novel_content_parser.dart';

void main() {
  group('NovelContentParser', () {
    test('Trích xuất canonical anchor từ data-anchor-block-id và data-block-type', () {
      const html = '''
        <h1 data-anchor-block-id="blk_0001_h1" data-block-type="HEADING">Tiêu đề chương</h1>
        <p data-anchor-block-id="blk_0002_p" data-block-type="NARRATION">Đây là lời dẫn chuyện.</p>
        <p data-anchor-block-id="blk_0003_dlg" data-block-type="DIALOGUE">「Cậu đang làm gì thế?」</p>
      ''';

      final blocks = NovelContentParser.parseHtml(html);

      expect(blocks.length, 3);

      expect(blocks[0].anchorBlockId, 'blk_0001_h1');
      expect(blocks[0].blockType, NovelBlockType.heading);
      expect(blocks[0].rawText, 'Tiêu đề chương');
      expect(blocks[0].level, 1);

      expect(blocks[1].anchorBlockId, 'blk_0002_p');
      expect(blocks[1].blockType, NovelBlockType.narration);
      expect(blocks[1].rawText, 'Đây là lời dẫn chuyện.');

      expect(blocks[2].anchorBlockId, 'blk_0003_dlg');
      expect(blocks[2].blockType, NovelBlockType.dialogue);
      expect(blocks[2].rawText, '「Cậu đang làm gì thế?」');
    });

    test('Tightening 1: Tuyệt đối KHÔNG nhận id="blk_..." làm canonical anchor', () {
      // Trường hợp tài liệu nguồn bên ngoài mang thuộc tính id="blk_..." nhưng không do pipeline phát hành
      const html = '''
        <p id="blk_9999_p">Đoạn văn có generic id từ nguồn EPUB cũ.</p>
        <h2 id="blk_8888_h2">Tiêu đề có id</h2>
      ''';

      final blocks = NovelContentParser.parseHtml(html);

      expect(blocks.length, 2);
      // anchorBlockId phải là null vì không có data-anchor-block-id
      expect(blocks[0].anchorBlockId, isNull);
      expect(blocks[1].anchorBlockId, isNull);
    });

    test('Fail-soft Legacy HTML: Trả về blocks với anchorBlockId = null khi không có anchor metadata', () {
      const html = '''
        <h1>Chương Mở Đầu</h1>
        <p>Văn bản thuần túy không có bất kỳ metadata nào từ trước tới nay.</p>
        <hr />
      ''';

      final blocks = NovelContentParser.parseHtml(html);

      expect(blocks.length, 3);
      expect(blocks[0].anchorBlockId, isNull);
      expect(blocks[0].blockType, NovelBlockType.heading);

      expect(blocks[1].anchorBlockId, isNull);
      expect(blocks[1].blockType, NovelBlockType.narration);

      expect(blocks[2].anchorBlockId, isNull);
      expect(blocks[2].blockType, NovelBlockType.divider);
    });

    test('Tightening 2: Chặn triệt để URL nguy hiểm (javascript:, vbscript:, data:*) trên ảnh', () {
      const html = '''
        <figure>
          <img src="javascript:alert('xss')" alt="Dangerous JS" />
        </figure>
        <figure>
          <img src="vbscript:msgbox('xss')" alt="Dangerous VBS" />
        </figure>
        <figure>
          <img src="data:text/html,<script>alert(1)</script>" alt="Dangerous Data HTML" />
        </figure>
        <figure>
          <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="Data Image" />
        </figure>
        <figure>
          <img src="https://storage.omninovel.test/safe-cover.jpg" alt="Safe Image" />
          <figcaption>Ảnh bìa an toàn</figcaption>
        </figure>
      ''';

      final blocks = NovelContentParser.parseHtml(html);

      // Chỉ có ảnh an toàn https:// mới được chấp nhận
      expect(blocks.length, 1);
      expect(blocks[0].illustrationSrc, 'https://storage.omninovel.test/safe-cover.jpg');
      expect(blocks[0].illustrationCaption, 'Ảnh bìa an toàn');
    });

    test('Bảo toàn Semantic Inline Spans: strong, em, ruby', () {
      const html = '''
        <p>
          Bầu trời <strong>rực sáng</strong> với ánh sao <em>lấp lánh</em>.
          Vị anh hùng mang tên <ruby><rb>夜空</rb><rp>(</rp><rt>よぞら</rt><rp>)</rp></ruby>.
        </p>
      ''';

      final blocks = NovelContentParser.parseHtml(html);

      expect(blocks.length, 1);
      final spans = blocks[0].inlineSpans;

      expect(spans.any((s) => s is TextSpanItem && s.isBold && s.text.contains('rực sáng')), isTrue);
      expect(spans.any((s) => s is TextSpanItem && s.isItalic && s.text.contains('lấp lánh')), isTrue);

      final ruby = spans.firstWhere((s) => s is RubySpanItem) as RubySpanItem;
      expect(ruby.baseText, '夜空');
      expect(ruby.rubyText, 'よぞら');
      expect(ruby.parenthesisText, '(');
    });
  });
}
