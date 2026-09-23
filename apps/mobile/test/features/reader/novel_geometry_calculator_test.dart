import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:omninovel_mobile/features/reader/models/novel_block_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/novel_geometry_calculator.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('NovelGeometryCalculator', () {
    const settings = NovelTypographySettings(
      fontSize: 16.0,
      lineHeightMultiplier: 1.5,
      horizontalPadding: 20.0,
      paragraphSpacing: 16.0,
    );

    final blocks = [
      const NovelBlockItem(
        anchorBlockId: 'blk_0001_h1',
        blockType: NovelBlockType.heading,
        rawText: 'Tiêu đề chương',
        level: 1,
      ),
      const NovelBlockItem(
        anchorBlockId: 'blk_0002_p',
        blockType: NovelBlockType.narration,
        rawText: 'Đoạn văn thứ nhất có độ dài tương đối ngắn gọn.',
      ),
      const NovelBlockItem(
        anchorBlockId: null, // Divider không có anchor
        blockType: NovelBlockType.divider,
        rawText: '',
      ),
      const NovelBlockItem(
        anchorBlockId: 'blk_0003_dlg',
        blockType: NovelBlockType.dialogue,
        rawText: '「Lời thoại trực tiếp của nhân vật chính」',
      ),
    ];

    test('Đo đạc chiều cao và tạo mảng cumulativeOffsets chính xác', () {
      final calculator = NovelGeometryCalculator(
        blocks: blocks,
        settings: settings,
        containerWidth: 400.0,
      );

      expect(calculator.blockHeights.length, 4);
      expect(calculator.cumulativeOffsets.length, 4);

      // Block 0 luôn bắt đầu ở offset 0.0
      expect(calculator.cumulativeOffsets[0], 0.0);
      expect(calculator.blockHeights[0], greaterThan(0.0));

      // Block 1 bắt đầu sau Block 0 + paragraphSpacing
      final expectedOffset1 = calculator.blockHeights[0] + settings.paragraphSpacing;
      expect(calculator.cumulativeOffsets[1], closeTo(expectedOffset1, 0.01));

      // Tổng chiều cao lớn hơn 0
      expect(calculator.totalHeight, greaterThan(calculator.cumulativeOffsets.last));
    });

    test('Định vị chính xác offset cuộn cho canonical anchorBlockId', () {
      final calculator = NovelGeometryCalculator(
        blocks: blocks,
        settings: settings,
        containerWidth: 400.0,
      );

      expect(calculator.getOffsetForAnchor('blk_0001_h1'), 0.0);
      expect(calculator.getOffsetForAnchor('blk_0002_p'), calculator.cumulativeOffsets[1]);
      expect(calculator.getOffsetForAnchor('blk_0003_dlg'), calculator.cumulativeOffsets[3]);

      // Anchor không tồn tại hoặc null trả về null
      expect(calculator.getOffsetForAnchor('blk_9999_unknown'), isNull);
      expect(calculator.getOffsetForAnchor(null), isNull);
    });

    test('Binary Search findIndexAtOffset tìm đúng block đang ở viewport', () {
      final calculator = NovelGeometryCalculator(
        blocks: blocks,
        settings: settings,
        containerWidth: 400.0,
      );

      // Điểm 0.0 thuộc Block 0
      expect(calculator.findIndexAtOffset(0.0), 0);

      // Giữa Block 1 thuộc Block 1
      final midBlock1 = calculator.cumulativeOffsets[1] + (calculator.blockHeights[1] / 2);
      expect(calculator.findIndexAtOffset(midBlock1), 1);

      // Vị trí của Block 3 thuộc Block 3
      expect(calculator.findIndexAtOffset(calculator.cumulativeOffsets[3]), 3);

      // Vượt quá phạm vi trả về block cuối cùng
      expect(calculator.findIndexAtOffset(calculator.totalHeight + 1000.0), 3);
    });
  });
}
