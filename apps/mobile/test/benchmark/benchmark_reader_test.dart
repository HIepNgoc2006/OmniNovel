import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_image_cache_coordinator.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_controller.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_state.dart';
import 'package:omninovel_mobile/features/reader/presentation/webtoon_geometry_calculator.dart';
import 'package:omninovel_mobile/features/reader/presentation/webtoon_reader_view.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';

class MockChapterRepository extends Mock implements ChapterRepository {}
class MockMediaRepository extends Mock implements MediaRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // Tạo fixture 150 trang Webtoon với kích thước không đồng nhất (Mixed Dimensions)
  final mixedPages150 = List.generate(150, (i) {
    // Luân phiên các kích thước:
    // 0: chuẩn 800x1200
    // 1: siêu dài 800x3200
    // 2: trung bình 1080x1920
    // 3: cực dài 1080x4320
    // 4: rộng ngang 1440x1800
    final type = i % 5;
    final (w, h) = switch (type) {
      0 => (800, 1200),
      1 => (800, 3200),
      2 => (1080, 1920),
      3 => (1080, 4320),
      _ => (1440, 1800),
    };
    return ChapterPage(
      assetId: 'asset-stress-$i',
      sortOrder: i + 1,
      width: w,
      height: h,
    );
  });

  group('Webtoon 150-Page Stress & Invariant Tests', () {
    test('Geometry Invariant: 150 mixed pages offsets strictly monotonically increasing', () {
      final calculator = WebtoonGeometryCalculator(
        viewportWidth: 400.0,
        pages: mixedPages150,
      );

      expect(calculator.totalContentHeight, greaterThan(100000.0));

      double prevOffset = -1.0;
      for (int i = 0; i < 150; i++) {
        final offset = calculator.getOffsetForPage(i);
        expect(offset, greaterThan(prevOffset));
        prevOffset = offset;
      }

      // Kiểm tra Binary search trên 100 điểm offset ngẫu nhiên
      final rand = math.Random(42);
      for (int step = 0; step < 100; step++) {
        final sampleOffset = rand.nextDouble() * calculator.totalContentHeight;
        final foundIndex = calculator.findIndexAtOffset(sampleOffset);
        final start = calculator.getOffsetForPage(foundIndex);
        final end = foundIndex + 1 < 150
            ? calculator.getOffsetForPage(foundIndex + 1)
            : calculator.totalContentHeight;

        expect(sampleOffset, greaterThanOrEqualTo(start));
        expect(sampleOffset, lessThanOrEqualTo(end));
      }
    });

    test('Memory Boundedness Invariant: Scrolling 150 pages keeps active bitmap memory bounded', () async {
      final mockMedia = MockMediaRepository();
      when(() => mockMedia.getMediaDownloadUrl(any(), forceRefresh: any(named: 'forceRefresh')))
          .thenAnswer((inv) async => 'https://cdn.example.com/${inv.positionalArguments[0]}.jpg');

      final coordinator = ReaderImageCacheCoordinator(
        mediaRepository: mockMedia,
        imageBudgetBytes: 80 * 1024 * 1024, // 80MB
      );

      final mockChapter = MockChapterRepository();
      final controller = ReaderSessionController(
        chapterRepository: mockChapter,
        imageCacheCoordinator: coordinator,
      );

      final detail = ChapterDetail(
        story: const ChapterStorySummary(id: 's1', slug: 'solo', title: 'Solo'),
        chapter: const ChapterHeaderSummary(id: 'ch1', chapterNumber: '1'),
        pages: mixedPages150,
      );
      when(() => mockChapter.getChapterDetail('ch1', versionId: null))
          .thenAnswer((_) async => detail);

      await controller.loadChapter('ch1');

      final calculator = WebtoonGeometryCalculator(
        viewportWidth: 412.0,
        pages: mixedPages150,
      );

      // Giả lập người dùng cuộn liên tục từ trang 0 tới trang 149
      for (int page = 0; page < 150; page += 2) {
        final scrollOffset = calculator.getOffsetForPage(page);
        final (start, end) = calculator.findVisibleRange(scrollOffset, 800.0);
        final focused = calculator.findFocusedPage(scrollOffset, 800.0);

        controller.updateVisibleRange(
          context: MockBuildContextHelper(),
          startIndex: start,
          endIndex: end,
          focusedIndex: focused,
          scrollOffset: scrollOffset,
          maxScrollOffset: calculator.totalContentHeight,
          targetWidth: 1080,
        );

        // Bất biến bộ nhớ: Ngân sách bộ nhớ active không bao giờ vượt quá ngân sách đã cấu hình
        expect(coordinator.currentDecodedBytes, lessThanOrEqualTo(85 * 1024 * 1024));
      }

      coordinator.dispose();
      controller.dispose();
    });

    testWidgets('Widget Stress: Render 150-page WebtoonReaderView and scroll to middle', (tester) async {
      final mockMedia = MockMediaRepository();
      when(() => mockMedia.getMediaDownloadUrl(any(), forceRefresh: any(named: 'forceRefresh')))
          .thenAnswer((inv) async => 'https://cdn.example.com/${inv.positionalArguments[0]}.jpg');

      final coordinator = ReaderImageCacheCoordinator(
        mediaRepository: mockMedia,
        imageBudgetBytes: 80 * 1024 * 1024,
      );

      final mockChapter = MockChapterRepository();
      final controller = ReaderSessionController(
        chapterRepository: mockChapter,
        imageCacheCoordinator: coordinator,
      );

      final detail = ChapterDetail(
        story: const ChapterStorySummary(id: 's1', slug: 'solo', title: 'Solo'),
        chapter: const ChapterHeaderSummary(id: 'ch1', chapterNumber: '1'),
        pages: mixedPages150,
      );
      when(() => mockChapter.getChapterDetail('ch1', versionId: null))
          .thenAnswer((_) async => detail);

      await controller.loadChapter('ch1', initialPageIndex: 75);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WebtoonReaderView(
              controller: controller,
              imageCacheCoordinator: coordinator,
              initialPageIndex: 75,
            ),
          ),
        ),
      );

      // Layout completed and initial jump postFrameCallback executed
      await tester.pumpAndSettle();

      expect(controller.state.status, ReaderStatus.ready);
      expect(controller.state.totalPages, 150);

      // Verify that the view renders without throwing overflow/OOM
      expect(find.byType(WebtoonReaderView), findsOneWidget);

      coordinator.dispose();
      controller.dispose();
    });
  });
}

class MockBuildContextHelper extends Fake implements BuildContext {}
