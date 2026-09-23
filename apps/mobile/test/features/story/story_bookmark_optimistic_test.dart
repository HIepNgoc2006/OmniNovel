import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/library/models/library_models.dart';
import 'package:omninovel_mobile/features/library/repositories/library_repository.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart';
import 'package:omninovel_mobile/features/story/presentation/story_detail_screen.dart';
import 'package:omninovel_mobile/features/story/repositories/story_repository.dart';

class MockStoryRepository extends Mock implements StoryRepository {}
class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}
class MockLibraryRepository extends Mock implements LibraryRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockStoryRepository mockStoryRepo;
  late MockReadingProgressRepository mockProgressRepo;
  late MockLibraryRepository mockLibraryRepo;

  const dummyStory = StoryDetail(
    id: 'story-123',
    slug: 'test-story',
    title: 'Test Story',
    summary: 'A test story summary',
    followersCount: 10,
  );

  setUp(() {
    mockStoryRepo = MockStoryRepository();
    mockProgressRepo = MockReadingProgressRepository();
    mockLibraryRepo = MockLibraryRepository();

    when(() => mockStoryRepo.getStoryBySlug('test-story')).thenAnswer((_) async => dummyStory);
    when(() => mockLibraryRepo.getBookmarkStatus('story-123')).thenAnswer(
      (_) async => const BookmarkStatusResponse(isBookmarked: false),
    );
    when(() => mockProgressRepo.getProgress('story-123')).thenAnswer(
      (_) async => const ReadingProgressResponse(storyId: 'story-123', writeEpoch: 1),
    );
    when(() => mockProgressRepo.getLocalCheckpoint('story-123')).thenAnswer((_) async => null);
    when(() => mockProgressRepo.ensureServerEpoch('story-123')).thenAnswer((_) async => 1);
    when(() => mockProgressRepo.setServerEpoch(any(), any())).thenReturn(null);
    when(() => mockProgressRepo.getCachedServerEpoch(any())).thenReturn(1);
    when(() => mockProgressRepo.getLocalGeneration(any())).thenReturn(0);
  });

  Widget buildTestWidget() {
    return MaterialApp(
      home: StoryDetailScreen(
        slug: 'test-story',
        storyRepository: mockStoryRepo,
        readingProgressRepository: mockProgressRepo,
        libraryRepository: mockLibraryRepo,
      ),
    );
  }

  group('Gate 8: Story Bookmark Optimistic UI & Rollback Tests', () {
    testWidgets('Toggling bookmark updates UI optimistically to bookmarked state', (tester) async {
      when(() => mockLibraryRepo.setBookmark('story-123', true)).thenAnswer(
        (_) async => const BookmarkStatusResponse(isBookmarked: true),
      );

      await tester.pumpWidget(buildTestWidget());
      await tester.pumpAndSettle();

      final bookmarkBtn = find.byKey(const Key('story_bookmark_button'));
      expect(bookmarkBtn, findsOneWidget);

      // Ban đầu chưa bookmark (Icons.bookmark_border)
      expect(find.byIcon(Icons.bookmark_border), findsOneWidget);
      expect(find.byIcon(Icons.bookmark), findsNothing);

      // Tap bookmark
      await tester.tap(bookmarkBtn);
      await tester.pump(); // Không dùng pumpAndSettle để kiểm tra optimistic frame

      // UI cập nhật ngay lập tức thành đã bookmark
      expect(find.byIcon(Icons.bookmark), findsOneWidget);
      expect(find.byIcon(Icons.bookmark_border), findsNothing);

      await tester.pumpAndSettle();
      verify(() => mockLibraryRepo.setBookmark('story-123', true)).called(1);
    });

    testWidgets('Toggling bookmark rolls back UI on server error', (tester) async {
      final completer = Completer<BookmarkStatusResponse>();
      when(() => mockLibraryRepo.setBookmark('story-123', true)).thenAnswer((_) => completer.future);

      await tester.pumpWidget(buildTestWidget());
      await tester.pumpAndSettle();

      final bookmarkBtn = find.byKey(const Key('story_bookmark_button'));
      expect(bookmarkBtn, findsOneWidget);
      expect(find.byIcon(Icons.bookmark_border), findsOneWidget);

      // Tap bookmark
      await tester.tap(bookmarkBtn);
      await tester.pump();

      // Optimistic frame: tạm thời đổi sang Icons.bookmark
      expect(find.byIcon(Icons.bookmark), findsOneWidget);

      // Server hoàn tất với lỗi 500
      completer.completeError(Exception('Network failure 500'));
      await tester.pumpAndSettle();

      // Khi server trả lỗi, await xong -> rollback lại Icons.bookmark_border
      expect(find.byIcon(Icons.bookmark_border), findsOneWidget);
      expect(find.byIcon(Icons.bookmark), findsNothing);

      // SnackBar hiển thị thông báo lỗi
      expect(find.byType(SnackBar), findsOneWidget);
      expect(find.textContaining('Không thể cập nhật theo dõi'), findsOneWidget);
    });
  });
}
