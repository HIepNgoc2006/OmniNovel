import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_screen.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart';
import 'package:omninovel_mobile/features/story/presentation/story_detail_screen.dart';
import 'package:omninovel_mobile/features/story/repositories/story_repository.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MockAuthService extends Mock implements AuthService {}

class MockStoryRepository extends Mock implements StoryRepository {}

class MockChapterRepository extends Mock implements ChapterRepository {}

class MockMediaRepository extends Mock implements MediaRepository {}

class MockReadingProgressRepository extends Mock
    implements ReadingProgressRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockAuthService mockAuthService;
  late MockStoryRepository mockStoryRepo;
  late MockChapterRepository mockChapterRepo;
  late MockMediaRepository mockMediaRepo;
  late MockReadingProgressRepository mockProgressRepo;

  const testStory = StoryDetail(
    id: 'story-101',
    slug: 'solo-leveling',
    title: 'Tôi Thăng Cấp Một Mình',
    summary: 'Hành trình từ thợ săn yếu nhất trở thành thợ săn bóng tối.',
    status: 'COMPLETED',
    genres: [
      Genre(id: 'g-1', name: 'Action', slug: 'action'),
      Genre(id: 'g-2', name: 'Fantasy', slug: 'fantasy'),
    ],
    editions: [
      StoryEdition(
        id: 'ed-1',
        editionName: 'Default Edition',
        isDefault: true,
        chapters: [
          ChapterItemSummary(
            id: 'ch-1',
            chapterNumber: '1',
            title: 'Khởi đầu hầm ngục kép',
          ),
          ChapterItemSummary(
            id: 'ch-2',
            chapterNumber: '2',
            title: 'Lựa chọn của kẻ yếu',
          ),
        ],
      ),
    ],
  );

  const testChapter1 = ChapterDetail(
    story: ChapterStorySummary(
      id: 'story-101',
      slug: 'solo-leveling',
      title: 'Tôi Thăng Cấp Một Mình',
    ),
    chapter: ChapterHeaderSummary(
      id: 'ch-1',
      chapterNumber: '1',
      title: 'Khởi đầu hầm ngục kép',
    ),
    pages: [
      ChapterPage(assetId: 'asset-1', sortOrder: 1, width: 800, height: 1200),
      ChapterPage(assetId: 'asset-2', sortOrder: 2, width: 800, height: 1200),
      ChapterPage(assetId: 'asset-3', sortOrder: 3, width: 800, height: 1200),
    ],
    navigation: ChapterNavigation(
      previous: null,
      next: ChapterNavSummary(id: 'ch-2', chapterNumber: '2', title: 'Lựa chọn'),
    ),
  );

  const testChapter2 = ChapterDetail(
    story: ChapterStorySummary(
      id: 'story-101',
      slug: 'solo-leveling',
      title: 'Tôi Thăng Cấp Một Mình',
    ),
    chapter: ChapterHeaderSummary(
      id: 'ch-2',
      chapterNumber: '2',
      title: 'Lựa chọn của kẻ yếu',
    ),
    pages: [
      ChapterPage(assetId: 'asset-4', sortOrder: 1, width: 800, height: 1200),
    ],
    navigation: ChapterNavigation(
      previous: ChapterNavSummary(id: 'ch-1', chapterNumber: '1', title: 'Khởi đầu'),
      next: null,
    ),
  );

  setUpAll(() {
    registerFallbackValue(const ReadingProgressPayload(
      storyId: 'story-dummy',
      chapterId: 'ch-dummy',
      pageIndex: 1,
      progressPercentage: 0,
      scrollPosition: 0,
    ));
    registerFallbackValue(LocalReadingCheckpoint(
      storyId: 'story-dummy',
      chapterId: 'ch-dummy',
      pageIndex: 1,
      progressPercentage: 0,
      scrollPosition: 0,
      updatedAt: DateTime.now(),
    ));
  });

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    mockAuthService = MockAuthService();
    mockStoryRepo = MockStoryRepository();
    mockChapterRepo = MockChapterRepository();
    mockMediaRepo = MockMediaRepository();
    mockProgressRepo = MockReadingProgressRepository();

    when(() => mockAuthService.state).thenReturn(AuthState.authenticated(
      user: const User(
        id: 'u-1',
        username: 'tester',
        email: 'test@omninovel.com',
        role: 'READER',
      ),
      accessToken: 'token-123',
    ));

    when(() => mockStoryRepo.getStoryBySlug('solo-leveling'))
        .thenAnswer((_) async => testStory);

    when(() => mockChapterRepo.getChapterDetail('ch-1'))
        .thenAnswer((_) async => testChapter1);

    when(() => mockChapterRepo.getChapterDetail('ch-2'))
        .thenAnswer((_) async => testChapter2);

    when(() => mockMediaRepo.getMediaDownloadUrl(any(),
            forceRefresh: any(named: 'forceRefresh')))
        .thenAnswer((_) async => 'https://cdn.omninovel.com/test.jpg');

    when(() => mockProgressRepo.getLocalCheckpoint(any()))
        .thenAnswer((_) async => null);

    when(() => mockProgressRepo.getProgress(any()))
        .thenAnswer((_) async => const ReadingProgressResponse(storyId: ''));

    when(() => mockProgressRepo.saveLocalCheckpoint(any()))
        .thenAnswer((_) async {});

    when(() => mockProgressRepo.saveProgress(any())).thenAnswer(
      (invocation) async => ReadingProgressResponse(
        storyId: 'story-101',
        chapterId: 'ch-1',
        pageIndex: 1,
        progressPercentage: 0,
        scrollPosition: 0,
        updatedAt: DateTime.now(),
      ),
    );
  });

  Widget buildRouterApp({String initialLocation = '/story/solo-leveling'}) {
    final router = GoRouter(
      initialLocation: initialLocation,
      routes: [
        GoRoute(
          path: '/story/:slug',
          builder: (context, state) => StoryDetailScreen(
            slug: state.pathParameters['slug']!,
            storyRepository: mockStoryRepo,
            readingProgressRepository: mockProgressRepo,
          ),
        ),
        GoRoute(
          path: '/reader/:chapterId',
          builder: (context, state) {
            final chapterId = state.pathParameters['chapterId']!;
            final storyId = state.uri.queryParameters['storyId'] ?? '';
            final pageIndexStr = state.uri.queryParameters['pageIndex'];
            final initialPageIndex =
                pageIndexStr != null ? (int.tryParse(pageIndexStr) ?? 0) : 0;
            return ReaderScreen(
              key: ValueKey('reader_$chapterId'),
              chapterId: chapterId,
              storyId: storyId,
              initialPageIndex: initialPageIndex,
              chapterRepository: mockChapterRepo,
              mediaRepository: mockMediaRepo,
              readingProgressRepository: mockProgressRepo,
            );
          },
        ),
      ],
    );

    return MaterialApp.router(
      routerConfig: router,
    );
  }

  group('Phase 5B Vertical Slice — Story Detail to Webtoon Reader', () {
    testWidgets('StoryDetailScreen displays story info, genres, chapters and Read from start button', (tester) async {
      await tester.pumpWidget(buildRouterApp());

      // Loading state
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle();

      // Content rendered
      expect(find.text('Tôi Thăng Cấp Một Mình'), findsAtLeastNWidgets(1));
      expect(find.text('Action'), findsOneWidget);
      expect(find.text('Fantasy'), findsOneWidget);
      expect(find.text('2 chương • COMPLETED'), findsOneWidget);
      expect(find.text('Hành trình từ thợ săn yếu nhất trở thành thợ săn bóng tối.'), findsOneWidget);

      // Buttons & Chapter list
      expect(find.byKey(const Key('read_from_start_button')), findsOneWidget);
      expect(find.byKey(const Key('resume_reading_button')), findsNothing); // Chưa có checkpoint
      expect(find.text('Chương 1: Khởi đầu hầm ngục kép'), findsOneWidget);
      expect(find.text('Chương 2: Lựa chọn của kẻ yếu'), findsOneWidget);
    });

    testWidgets('StoryDetailScreen displays Resume Reading button when checkpoint exists', (tester) async {
      when(() => mockProgressRepo.getLocalCheckpoint('story-101'))
          .thenAnswer((_) async => LocalReadingCheckpoint(
                storyId: 'story-101',
                chapterId: 'ch-1',
                pageIndex: 3, // 1-based server index
                progressPercentage: 66.0,
                scrollPosition: 0.66,
                updatedAt: DateTime.now(),
              ));

      await tester.pumpWidget(buildRouterApp());
      await tester.pumpAndSettle();

      // Hiển thị nút "Đọc tiếp (Trang 3)"
      expect(find.byKey(const Key('resume_reading_button')), findsOneWidget);
      expect(find.text('Đọc tiếp (Trang 3)'), findsOneWidget);
      expect(find.byKey(const Key('read_from_start_button')), findsOneWidget);
    });

    testWidgets('ReaderScreen loads chapter pages and toggles overlay bars on tap', (tester) async {
      await tester.pumpWidget(buildRouterApp(initialLocation: '/reader/ch-1?storyId=story-101&pageIndex=0'));

      // Initial loading
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle();

      // Chapter loaded: overlay ban đầu ẩn
      expect(find.text('Chương 1: Khởi đầu hầm ngục kép'), findsNothing);

      // Chạm vào màn hình để bật overlay
      await tester.tap(find.byType(ReaderScreen));
      await tester.pumpAndSettle();

      // Sau khi tap, overlay header hiện ra với tiêu đề chương
      expect(find.text('Chương 1: Khởi đầu hầm ngục kép'), findsOneWidget);
      expect(find.text('Trang 1 / 3'), findsOneWidget);
      expect(find.text('Chương sau'), findsOneWidget);

      // Chạm lại lần nữa để ẩn overlay
      await tester.tap(find.byType(ReaderScreen));
      await tester.pumpAndSettle();

      expect(find.text('Chương 1: Khởi đầu hầm ngục kép'), findsNothing);
    });

    testWidgets('ReaderScreen navigates to next chapter when clicking next chapter button', (tester) async {
      await tester.pumpWidget(buildRouterApp(initialLocation: '/reader/ch-1?storyId=story-101&pageIndex=0'));

      await tester.pumpAndSettle();

      // Bật overlay
      await tester.tap(find.byType(ReaderScreen));
      await tester.pumpAndSettle();

      // Nhấn nút "Chương sau"
      await tester.tap(find.text('Chương sau'));
      await tester.pump(); // Bắt đầu pushReplacement sang chapter 2
      await tester.pumpAndSettle(); // Hoàn tất loading chapter 2

      // Đã gọi load chapter 2
      verify(() => mockChapterRepo.getChapterDetail('ch-2')).called(1);
    });

    testWidgets('Vertical Slice: Click Read from start navigates into ReaderScreen smoothly', (tester) async {
      await tester.pumpWidget(buildRouterApp());
      await tester.pumpAndSettle();

      // Click "Đọc từ đầu (Chương 1)" từ Story Detail
      await tester.tap(find.byKey(const Key('read_from_start_button')));
      await tester.pump(); // Bắt đầu push router
      await tester.pumpAndSettle(); // Hoàn tất render ReaderScreen

      // Đã navigate vào ReaderScreen và load chapter 1
      verify(() => mockChapterRepo.getChapterDetail('ch-1')).called(1);
      expect(find.byType(ReaderScreen), findsOneWidget);
    });

    testWidgets('Vertical Slice: Kill-App resumption recovers exact page index on reload', (tester) async {
      final now = DateTime.now();
      when(() => mockProgressRepo.getLocalCheckpoint('story-101'))
          .thenAnswer((_) async => LocalReadingCheckpoint(
                storyId: 'story-101',
                chapterId: 'ch-1',
                pageIndex: 2, // 1-based (trang 2)
                progressPercentage: 50.0,
                scrollPosition: 0.5,
                updatedAt: now,
              ));

      // 1. Mở Story Detail thấy nút Đọc tiếp trang 2
      await tester.pumpWidget(buildRouterApp());
      await tester.pumpAndSettle();

      final resumeBtn = find.byKey(const Key('resume_reading_button'));
      expect(resumeBtn, findsOneWidget);
      expect(find.text('Đọc tiếp (Trang 2)'), findsOneWidget);

      // 2. Click nút "Đọc tiếp (Trang 2)"
      await tester.tap(resumeBtn);
      await tester.pump();
      await tester.pumpAndSettle();

      // ReaderScreen mở ra đúng trang 2
      expect(find.byType(ReaderScreen), findsOneWidget);

      // Bật overlay để xác nhận reader đang ở đúng trang 2 / 3
      await tester.tap(find.byType(ReaderScreen));
      await tester.pumpAndSettle();

      expect(find.text('Trang 2 / 3'), findsOneWidget);
    });
  });
}
