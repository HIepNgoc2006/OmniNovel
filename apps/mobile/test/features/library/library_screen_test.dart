import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/library/models/library_models.dart';
import 'package:omninovel_mobile/features/library/presentation/library_screen.dart';
import 'package:omninovel_mobile/features/library/repositories/library_repository.dart';

class MockLibraryRepository extends Mock implements LibraryRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockLibraryRepository mockLibraryRepo;

  final dummyHistoryItem = ReadingHistoryItem(
    story: const LibraryStorySummary(
      id: 'story-1',
      title: 'Solo Leveling',
      slug: 'solo-leveling',
      mediaFormat: 'COMIC',
      status: 'ONGOING',
      totalChapters: 10,
    ),
    chapter: const LibraryChapterSummary(
      id: 'chap-10',
      chapterNumber: 10,
      title: 'Hầm ngục D-Rank',
    ),
    resume: const ResumeSnapshot(
      readingMode: 'WEBTOON',
      pageIndex: 5,
      progressPercentage: 55.0,
      scrollPosition: 1200.0,
      textOffset: 0,
    ),
    updatedAt: DateTime.parse('2026-09-23T10:00:00Z'),
  );

  final dummyBookmarkItem = BookmarkedStoryItem(
    story: const LibraryStorySummary(
      id: 'story-2',
      title: 'Omniscient Reader',
      slug: 'orv',
      mediaFormat: 'COMIC',
      status: 'ONGOING',
      totalChapters: 200,
    ),
    bookmarkedAt: DateTime.parse('2026-09-22T08:00:00Z'),
    unreadChapterCount: 3,
  );

  setUp(() {
    mockLibraryRepo = MockLibraryRepository();

    when(() => mockLibraryRepo.getCachedBookmarks(status: any(named: 'status')))
        .thenReturn([dummyBookmarkItem]);
    when(() => mockLibraryRepo.getCachedHistory()).thenReturn([dummyHistoryItem]);
    when(() => mockLibraryRepo.getCachedContinueReading()).thenReturn(dummyHistoryItem);

    when(() => mockLibraryRepo.getContinueReading()).thenAnswer((_) async => dummyHistoryItem);
    when(() => mockLibraryRepo.fetchBookmarks(
          page: any(named: 'page'),
          limit: any(named: 'limit'),
          status: any(named: 'status'),
        )).thenAnswer(
      (_) async => PaginatedBookmarksResponse(
        data: [dummyBookmarkItem],
        pagination: const PaginationMeta(
          page: 1,
          limit: 20,
          totalItems: 1,
          totalPages: 1,
        ),
      ),
    );
    when(() => mockLibraryRepo.fetchHistory(
          page: any(named: 'page'),
          limit: any(named: 'limit'),
        )).thenAnswer(
      (_) async => PaginatedReadingHistoryResponse(
        data: [dummyHistoryItem],
        pagination: const PaginationMeta(
          page: 1,
          limit: 20,
          totalItems: 1,
          totalPages: 1,
        ),
      ),
    );
  });

  Widget buildTestWidget() {
    return MaterialApp(
      home: LibraryScreen(libraryRepository: mockLibraryRepo),
    );
  }

  group('Gate 9A & Gate 10: LibraryScreen UI & Lifecycle Tests', () {
    testWidgets('Renders Tabs, Continue Reading Hero Card and items correctly', (tester) async {
      await tester.pumpWidget(buildTestWidget());
      await tester.pumpAndSettle();

      // Verify Screen Title & Tabs
      expect(find.text('Tủ sách của tôi'), findsOneWidget);
      expect(find.text('Đang theo dõi'), findsOneWidget);
      expect(find.text('Lịch sử'), findsOneWidget);

      // Verify Bookmarks Tab content
      expect(find.text('Omniscient Reader'), findsOneWidget);
      expect(find.text('Tất cả'), findsOneWidget);
      expect(find.text('Đang ra'), findsOneWidget);
      expect(find.text('Hoàn thành'), findsOneWidget);

      // Switch to History Tab
      await tester.tap(find.text('Lịch sử'));
      await tester.pumpAndSettle();

      // Verify Continue Reading Hero Card
      expect(find.byKey(const Key('continue_reading_hero_card')), findsOneWidget);
      expect(find.text('TIẾP TỤC ĐỌC'), findsOneWidget);
      expect(find.text('Solo Leveling'), findsWidgets);
      expect(find.textContaining('Chương 10'), findsWidgets);
    });

    testWidgets('Clear all history shows confirmation dialog and executes on confirm', (tester) async {
      when(() => mockLibraryRepo.clearAllHistory()).thenAnswer((_) async => {});

      await tester.pumpWidget(buildTestWidget());
      await tester.pumpAndSettle();

      // Switch to History Tab
      await tester.tap(find.text('Lịch sử'));
      await tester.pumpAndSettle();

      final clearAllBtn = find.byKey(const Key('clear_all_history_button'));
      expect(clearAllBtn, findsOneWidget);

      // Tap clear all button
      await tester.tap(clearAllBtn);
      await tester.pumpAndSettle();

      // Dialog pops up
      expect(find.text('Xóa tất cả lịch sử'), findsOneWidget);
      expect(
        find.text('Toàn bộ lịch sử đọc và tiến độ của bạn sẽ bị xóa. Hành động này không thể hoàn tác.'),
        findsOneWidget,
      );

      // Confirm deletion
      await tester.tap(find.text('Xóa tất cả'));
      await tester.pumpAndSettle();

      verify(() => mockLibraryRepo.clearAllHistory()).called(1);
    });
  });
}
