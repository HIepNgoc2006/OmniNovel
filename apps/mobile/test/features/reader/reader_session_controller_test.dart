import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_image_cache_coordinator.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_controller.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_state.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';

class MockChapterRepository extends Mock implements ChapterRepository {}
class MockReaderImageCacheCoordinator extends Mock implements ReaderImageCacheCoordinator {}
class MockBuildContext extends Mock implements BuildContext {}

void main() {
  late MockChapterRepository mockRepo;
  late MockReaderImageCacheCoordinator mockCoordinator;
  late ReaderSessionController controller;

  setUpAll(() {
    registerFallbackValue(MockBuildContext());
  });

  setUp(() {
    mockRepo = MockChapterRepository();
    mockCoordinator = MockReaderImageCacheCoordinator();
    controller = ReaderSessionController(
      chapterRepository: mockRepo,
      imageCacheCoordinator: mockCoordinator,
    );
  });

  final dummyDetail = ChapterDetail(
    story: const ChapterStorySummary(id: 's1', slug: 'solo', title: 'Solo'),
    chapter: const ChapterHeaderSummary(id: 'ch1', chapterNumber: '1'),
    pages: List.generate(
      10,
      (i) => ChapterPage(
        assetId: 'asset-$i',
        sortOrder: i,
        width: 1080,
        height: 1920,
      ),
    ),
  );

  group('ReaderSessionController Tests', () {
    test('loadChapter success transitions state to ready with initial window', () async {
      when(() => mockRepo.getChapterDetail('ch1', versionId: null))
          .thenAnswer((_) async => dummyDetail);

      expect(controller.state.status, ReaderStatus.initial);

      await controller.loadChapter('ch1');

      expect(controller.state.status, ReaderStatus.ready);
      expect(controller.state.totalPages, 10);
      expect(controller.state.focusedPageIndex, 0);
      expect(controller.state.windowResult.visibleIndexes, {0});
      expect(controller.state.windowResult.adjacentIndexes, {1, 2});
    });

    test('loadChapter failure transitions state to error', () async {
      when(() => mockRepo.getChapterDetail('ch-err', versionId: null))
          .thenThrow(Exception('Network disconnected'));

      await controller.loadChapter('ch-err');

      expect(controller.state.status, ReaderStatus.error);
      expect(controller.state.errorMessage, contains('Network disconnected'));
    });

    testWidgets('updateVisibleRange updates window and triggers eviction & prefetch', (tester) async {
      when(() => mockRepo.getChapterDetail('ch1', versionId: null))
          .thenAnswer((_) async => dummyDetail);
      when(() => mockCoordinator.evictDistantBitmaps(
            pages: any(named: 'pages'),
            distantIndexes: any(named: 'distantIndexes'),
          )).thenReturn(null);
      when(() => mockCoordinator.prefetchAdjacentPages(
            context: any(named: 'context'),
            pages: any(named: 'pages'),
            adjacentIndexes: any(named: 'adjacentIndexes'),
            targetWidth: any(named: 'targetWidth'),
          )).thenAnswer((_) async => {});

      await controller.loadChapter('ch1');

      await tester.pumpWidget(
        Builder(
          builder: (context) {
            controller.updateVisibleRange(
              context: context,
              startIndex: 4,
              endIndex: 5,
              scrollOffset: 5000,
              maxScrollOffset: 10000,
            );
            return const Placeholder();
          },
        ),
      );

      expect(controller.state.focusedPageIndex, 4);
      expect(controller.state.visibleStartIndex, 4);
      expect(controller.state.visibleEndIndex, 5);
      expect(controller.state.progressPercentage, 50.0);
      expect(controller.state.windowResult.visibleIndexes, {4, 5});
      expect(controller.state.windowResult.adjacentIndexes, {2, 3, 6, 7});

      verify(() => mockCoordinator.evictDistantBitmaps(
            pages: any(named: 'pages'),
            distantIndexes: {0, 1, 8, 9},
          )).called(1);

      verify(() => mockCoordinator.prefetchAdjacentPages(
            context: any(named: 'context'),
            pages: any(named: 'pages'),
            adjacentIndexes: {2, 3, 6, 7},
            targetWidth: any(named: 'targetWidth'),
          )).called(1);
    });
  });
}
