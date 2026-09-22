import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/webtoon_geometry_calculator.dart';

void main() {
  group('WebtoonGeometryCalculator', () {
    // Giả lập 3 trang Webtoon với kích thước cực kỳ khác nhau:
    // Trang 0: 800 x 1200 (aspectRatio = 800/1200 = 0.6667)
    // Trang 1: 800 x 3200 (aspectRatio = 800/3200 = 0.25 -> dài gấp 2.67 lần trang 0)
    // Trang 2: 1200 x 1800 (aspectRatio = 1200/1800 = 0.6667)
    const pages = [
      ChapterPage(assetId: 'page-0', sortOrder: 1, width: 800, height: 1200),
      ChapterPage(assetId: 'page-1', sortOrder: 2, width: 800, height: 3200),
      ChapterPage(assetId: 'page-2', sortOrder: 3, width: 1200, height: 1800),
    ];

    // Với viewportWidth = 400.0:
    // Trang 0: height = 400 / (800/1200) = 600.0 (Y: [0, 600])
    // Trang 1: height = 400 / (800/3200) = 1600.0 (Y: [600, 2200])
    // Trang 2: height = 400 / (1200/1800) = 600.0 (Y: [2200, 2800])
    // Tổng chiều dài = 2800.0
    final calculator = WebtoonGeometryCalculator(
      viewportWidth: 400.0,
      pages: pages,
    );

    test('tính toán chính xác cumulative offsets và totalContentHeight', () {
      expect(calculator.getPageHeight(0), 600.0);
      expect(calculator.getPageHeight(1), 1600.0);
      expect(calculator.getPageHeight(2), 600.0);
      expect(calculator.totalContentHeight, 2800.0);

      expect(calculator.getOffsetForPage(0), 0.0);
      expect(calculator.getOffsetForPage(1), 600.0);
      expect(calculator.getOffsetForPage(2), 2200.0);
    });

    test('Binary search findIndexAtOffset trả về đúng index theo offset', () {
      expect(calculator.findIndexAtOffset(0.0), 0);
      expect(calculator.findIndexAtOffset(599.9), 0);
      expect(calculator.findIndexAtOffset(600.0), 1);
      expect(calculator.findIndexAtOffset(1500.0), 1);
      expect(calculator.findIndexAtOffset(2199.9), 1);
      expect(calculator.findIndexAtOffset(2200.0), 2);
      expect(calculator.findIndexAtOffset(2799.0), 2);
      expect(calculator.findIndexAtOffset(3500.0), 2); // Clamp at end
    });

    test('calculateVisibleHeight tính đúng chiều cao giao nhau với viewport', () {
      // Viewport từ offset 400 đến 1000 (viewportHeight = 600)
      // Trang 0 [0, 600] giao [400, 1000] -> [400, 600] = 200.0
      // Trang 1 [600, 2200] giao [400, 1000] -> [600, 1000] = 400.0
      // Trang 2 [2200, 2800] giao [400, 1000] -> không giao = 0.0
      expect(calculator.calculateVisibleHeight(0, 400.0, 600.0), 200.0);
      expect(calculator.calculateVisibleHeight(1, 400.0, 600.0), 400.0);
      expect(calculator.calculateVisibleHeight(2, 400.0, 600.0), 0.0);
    });

    test('findFocusedPage xác định chính xác theo argmax(visibleHeight)', () {
      // Tại offset 400, viewport 600:
      // Trang 0 visible 200px, Trang 1 visible 400px -> Trang 1 là focused!
      expect(calculator.findFocusedPage(400.0, 600.0), 1);

      // Tại offset 100, viewport 600:
      // Trang 0 visible 500px, Trang 1 visible 100px -> Trang 0 là focused!
      expect(calculator.findFocusedPage(100.0, 600.0), 0);

      // Tại offset 2100, viewport 600 ([2100, 2700]):
      // Trang 1 [600, 2200] visible 100px.
      // Trang 2 [2200, 2800] visible 500px -> Trang 2 là focused!
      expect(calculator.findFocusedPage(2100.0, 600.0), 2);
    });

    test('hỗ trợ tie-breaker theo hướng cuộn khi 2 trang có diện tích hiển thị bằng nhau', () {
      // Offset 300, viewport 600: [300, 900]
      // Trang 0 [0, 600] visible = 300.0
      // Trang 1 [600, 2200] visible = 300.0
      expect(
        calculator.findFocusedPage(
          300.0,
          600.0,
          direction: ScrollDirectionPreference.down,
        ),
        1, // Cuộn xuống: ưu tiên trang tiếp theo
      );

      expect(
        calculator.findFocusedPage(
          300.0,
          600.0,
          direction: ScrollDirectionPreference.up,
        ),
        0, // Cuộn lên: giữ trang trước
      );
    });
  });
}
