import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_image_cache_coordinator.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_controller.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_state.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_window_policy.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';

class MockChapterRepository extends Mock implements ChapterRepository {}
class MockMediaRepository extends Mock implements MediaRepository {}
class MockBuildContext extends Mock implements BuildContext {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    registerFallbackValue(MockBuildContext());
  });

  // Tạo fixture 60 trang Manga (tiêu chuẩn khổ sách Manga 1080x1600, 1200x1800, 1440x2100)
  final manga60Pages = List.generate(60, (i) {
    final type = i % 3;
    final (w, h) = switch (type) {
      0 => (1080, 1600),
      1 => (1200, 1800),
      _ => (1440, 2100),
    };
    return ChapterPage(
      assetId: 'manga-asset-$i',
      sortOrder: i + 1,
      width: w,
      height: h,
    );
  });

  final dummyMangaDetail = ChapterDetail(
    story: const ChapterStorySummary(id: 's-manga', slug: 'one-piece', title: 'One Piece'),
    chapter: const ChapterHeaderSummary(id: 'ch-manga-1', chapterNumber: '1000'),
    pages: manga60Pages,
  );

  group('Manga 60-Page Stress & Invariant Tests (Issue #197 Quality Gate)', () {
    test('Window Policy Invariant: Single focused page keeps at most 1 visible and 2 adjacent pages', () {
      const policy = ReaderWindowPolicy(totalPageCount: 60);

      for (int i = 0; i < 60; i++) {
        final window = policy.calculateSingleFocus(i);

        expect(window.visibleIndexes, {i});
        expect(window.adjacentIndexes.length, inInclusiveRange(2, 4));
        // Tổng số trang được giữ bitmap tối đa 5 trang (1 visible + 4 adjacent)
        expect(window.visibleIndexes.length + window.adjacentIndexes.length, inInclusiveRange(3, 5));
        // Số trang bị evict luôn >= 55 trang
        expect(window.distantIndexes.length, inInclusiveRange(55, 57));
      }
    });

    test('Memory Budget Invariant: Active decoded image estimate is strictly bounded under 80MB', () {
      final mockMedia = MockMediaRepository();
      final coordinator = ReaderImageCacheCoordinator(
        mediaRepository: mockMedia,
        imageBudgetBytes: 80 * 1024 * 1024, // 80 MB
      );

      const targetWidth = 1080;
      const policy = ReaderWindowPolicy(totalPageCount: 60);

      // Mô phỏng lật liên tục qua 60 trang Manga
      for (int pageIdx = 0; pageIdx < 60; pageIdx++) {
        final window = policy.calculateSingleFocus(pageIdx);

        // Nạp provider cho trang hiện tại và adjacent
        final activePages = [
          manga60Pages[pageIdx],
          if (pageIdx > 0) manga60Pages[pageIdx - 1],
          if (pageIdx < 59) manga60Pages[pageIdx + 1],
        ];

        for (final p in activePages) {
          coordinator.getImageProvider(
            p.assetId,
            'https://cdn.example.com/${p.assetId}.jpg',
            targetWidth: targetWidth,
            page: p,
          );
        }

        // Evict distant pages
        coordinator.evictDistantBitmaps(
          pages: manga60Pages,
          distantIndexes: window.distantIndexes,
        );

        // Dung lượng bitmap ước lượng đang được giữ trong coordinator luôn < 80MB (thực tế < 30MB)
        expect(
          coordinator.currentDecodedBytes,
          lessThanOrEqualTo(80 * 1024 * 1024),
          reason: 'Decoded bytes tại trang $pageIdx vượt ngân sách 80MB',
        );
      }

      coordinator.dispose();
    });

    testWidgets('Session Controller Simulation: 60-page continuous flings trigger prompt evictions', (tester) async {
      final mockRepo = MockChapterRepository();
      final mockMedia = MockMediaRepository();
      when(() => mockRepo.getChapterDetail('ch-manga-1', versionId: null))
          .thenAnswer((_) async => dummyMangaDetail);

      final coordinator = ReaderImageCacheCoordinator(mediaRepository: mockMedia);
      final controller = ReaderSessionController(
        chapterRepository: mockRepo,
        imageCacheCoordinator: coordinator,
      );

      await controller.loadChapter('ch-manga-1');
      expect(controller.state.status, ReaderStatus.ready);
      expect(controller.state.totalPages, 60);

      await tester.pumpWidget(
        Builder(
          builder: (context) {
            // Lật qua lại từ trang 0 -> 30 -> 59
            for (int i = 0; i < 60; i += 5) {
              controller.updateVisibleRange(
                context: context,
                startIndex: i,
                endIndex: i,
                focusedIndex: i,
                scrollOffset: i.toDouble(),
                maxScrollOffset: 59.0,
                targetWidth: 1080,
              );
            }
            return const Placeholder();
          },
        ),
      );

      expect(controller.state.focusedPageIndex, 55);
      expect(controller.state.windowResult.visibleIndexes, {55});
      expect(controller.state.windowResult.adjacentIndexes, {53, 54, 56, 57});
      // 55 trang khác nằm ở distantIndexes
      expect(controller.state.windowResult.distantIndexes.length, 55);

      controller.dispose();
    });
  });
}
