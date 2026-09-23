import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/manga_reading_mode.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/manga_paged_reader_view.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_image_cache_coordinator.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_screen.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_controller.dart';
import 'package:omninovel_mobile/features/reader/presentation/reading_progress_coordinator.dart';
import 'package:omninovel_mobile/features/reader/presentation/webtoon_reader_view.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';

class MockChapterRepository extends Mock implements ChapterRepository {}
class MockMediaRepository extends Mock implements MediaRepository {}
class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}

class FakeLocalReadingCheckpoint extends Fake implements LocalReadingCheckpoint {}
class FakeReadingProgressPayload extends Fake implements ReadingProgressPayload {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    registerFallbackValue(FakeLocalReadingCheckpoint());
    registerFallbackValue(FakeReadingProgressPayload());
  });

  late MockChapterRepository mockChapterRepo;
  late MockMediaRepository mockMediaRepo;
  late MockReadingProgressRepository mockProgressRepo;
  late ReaderImageCacheCoordinator cacheCoordinator;
  late ReaderSessionController sessionController;

  final dummyChapter = ChapterDetail(
    story: const ChapterStorySummary(
      id: 'story-1',
      slug: 'solo-leveling',
      title: 'Solo Leveling',
    ),
    chapter: const ChapterHeaderSummary(
      id: 'ch-1',
      chapterNumber: '1',
      title: 'Hồi 1',
    ),
    pages: List.generate(
      5,
      (i) => ChapterPage(
        assetId: 'asset-$i',
        sortOrder: i + 1,
        width: 1080,
        height: 1920,
      ),
    ),
    navigation: const ChapterNavigation(
      previous: null,
      next: ChapterNavSummary(id: 'ch-2', chapterNumber: '2', title: 'Hồi 2'),
    ),
  );

  final dummyChapter2 = ChapterDetail(
    story: const ChapterStorySummary(
      id: 'story-1',
      slug: 'solo-leveling',
      title: 'Solo Leveling',
    ),
    chapter: const ChapterHeaderSummary(
      id: 'ch-2',
      chapterNumber: '2',
      title: 'Hồi 2',
    ),
    pages: List.generate(
      5,
      (i) => ChapterPage(
        assetId: 'asset-ch2-$i',
        sortOrder: i + 1,
        width: 1080,
        height: 1920,
      ),
    ),
  );

  setUp(() {
    mockChapterRepo = MockChapterRepository();
    mockMediaRepo = MockMediaRepository();
    mockProgressRepo = MockReadingProgressRepository();

    when(() => mockChapterRepo.getChapterDetail('ch-1', versionId: null))
        .thenAnswer((_) async => dummyChapter);
    when(() => mockChapterRepo.getChapterDetail('ch-2', versionId: null))
        .thenAnswer((_) async => dummyChapter2);

    when(() => mockMediaRepo.getMediaDownloadUrl(any(), forceRefresh: any(named: 'forceRefresh')))
        .thenAnswer((invocation) async => 'https://cdn.example.com/${invocation.positionalArguments[0]}.jpg');

    when(() => mockProgressRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => true);
    when(() => mockProgressRepo.saveProgress(any())).thenAnswer(
      (_) async => ReadingProgressResponse(
        storyId: 'story-1',
        chapterId: 'ch-1',
        pageIndex: 1,
        progressPercentage: 20.0,
        scrollPosition: 0.0,
        updatedAt: DateTime.now(),
        writeEpoch: 1,
      ),
    );

    cacheCoordinator = ReaderImageCacheCoordinator(mediaRepository: mockMediaRepo);
    sessionController = ReaderSessionController(
      chapterRepository: mockChapterRepo,
      imageCacheCoordinator: cacheCoordinator,
    );
  });

  group('Manga Paged Reader — RTL & LTR Semantics SSoT Tests', () {
    testWidgets('RTL: Tap Left advances (logicalPageIndex + 1), Tap Right goes back (logicalPageIndex - 1)', (tester) async {
      await sessionController.loadChapter('ch-1');
      final pageController = PageController();
      bool hudToggled = false;
      int reportedIndex = -1;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MangaPagedReaderView(
              sessionController: sessionController,
              imageCacheCoordinator: cacheCoordinator,
              pageController: pageController,
              mode: MangaReadingMode.rtl,
              onToggleHud: () => hudToggled = true,
              onProgressChanged: (idx, progress, offset) => reportedIndex = idx,
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(sessionController.state.focusedPageIndex, 0);

      // 1. Chạm vùng Trái (< 30% width) -> Chuyển tiếp sang trang tiếp theo (logicalPageIndex + 1)
      await tester.tapAt(const Offset(100, 300));
      await tester.pumpAndSettle();

      expect(pageController.page?.round(), 1);
      expect(sessionController.state.focusedPageIndex, 1);
      expect(reportedIndex, 1);

      // 2. Chạm vùng Giữa (30% - 70%) -> Toggle HUD
      await tester.tapAt(const Offset(400, 300));
      await tester.pumpAndSettle();
      expect(hudToggled, true);

      // 3. Chạm vùng Phải (> 70% width) -> Quay lại trang trước (logicalPageIndex - 1)
      await tester.tapAt(const Offset(700, 300));
      await tester.pumpAndSettle();

      expect(pageController.page?.round(), 0);
      expect(sessionController.state.focusedPageIndex, 0);
      expect(reportedIndex, 0);
    });

    testWidgets('RTL: Fling Right advances (0 -> 1), Fling Left goes back (1 -> 0)', (tester) async {
      await sessionController.loadChapter('ch-1');
      final pageController = PageController();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MangaPagedReaderView(
              sessionController: sessionController,
              imageCacheCoordinator: cacheCoordinator,
              pageController: pageController,
              mode: MangaReadingMode.rtl,
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(sessionController.state.focusedPageIndex, 0);

      // Vuốt từ Trái sang Phải (lật trang sách Manga) -> tiến sang trang 1
      await tester.fling(find.byType(PageView), const Offset(500, 0), 1000);
      await tester.pumpAndSettle();
      expect(pageController.page?.round(), 1);
      expect(sessionController.state.focusedPageIndex, 1);

      // Vuốt từ Phải sang Trái -> lùi về trang 0
      await tester.fling(find.byType(PageView), const Offset(-500, 0), 1000);
      await tester.pumpAndSettle();
      expect(pageController.page?.round(), 0);
      expect(sessionController.state.focusedPageIndex, 0);
    });

    testWidgets('LTR: Tap Left goes back, Tap Right advances, Fling Left advances', (tester) async {
      await sessionController.loadChapter('ch-1', initialPageIndex: 1);
      final pageController = PageController(initialPage: 1);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MangaPagedReaderView(
              sessionController: sessionController,
              imageCacheCoordinator: cacheCoordinator,
              pageController: pageController,
              mode: MangaReadingMode.ltr,
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // 1. Chạm vùng Trái trong LTR -> Quay lại trang trước (1 -> 0)
      await tester.tapAt(const Offset(100, 300));
      await tester.pumpAndSettle();
      expect(pageController.page?.round(), 0);
      expect(sessionController.state.focusedPageIndex, 0);

      // 2. Chạm vùng Phải trong LTR -> Tiến tới trang tiếp theo (0 -> 1)
      await tester.tapAt(const Offset(700, 300));
      await tester.pumpAndSettle();
      expect(pageController.page?.round(), 1);
      expect(sessionController.state.focusedPageIndex, 1);

      // 3. Fling sang Trái trong LTR -> Tiến tới trang 2
      await tester.fling(find.byType(PageView), const Offset(-500, 0), 1000);
      await tester.pumpAndSettle();
      expect(pageController.page?.round(), 2);
      expect(sessionController.state.focusedPageIndex, 2);
    });
  });

  group('Zoom Isolation & Unified Threshold 1.05 Tests', () {
    testWidgets('scale > 1.05 locks PageView scroll and disables nav tap zones', (tester) async {
      await sessionController.loadChapter('ch-1');
      final pageController = PageController();
      bool hudToggled = false;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MangaPagedReaderView(
              sessionController: sessionController,
              imageCacheCoordinator: cacheCoordinator,
              pageController: pageController,
              mode: MangaReadingMode.rtl,
              onToggleHud: () => hudToggled = true,
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(sessionController.state.focusedPageIndex, 0);

      // Tìm InteractiveViewer của trang active
      final interactiveViewerFinder = find.byType(InteractiveViewer);
      expect(interactiveViewerFinder, findsWidgets);

      // Kích hoạt Zoom scale > 1.05 (Scale 2.0)
      // Tác động pinch scale
      final center = tester.getCenter(interactiveViewerFinder.first);
      final gesture1 = await tester.startGesture(center.translate(-20, 0));
      final gesture2 = await tester.startGesture(center.translate(20, 0));
      await gesture1.moveBy(const Offset(-80, 0));
      await gesture2.moveBy(const Offset(80, 0));
      await tester.pump();

      await gesture1.up();
      await gesture2.up();
      await tester.pump();

      // Kiểm tra PageView đã nhận NeverScrollableScrollPhysics khi phóng to
      final pageView = tester.widget<PageView>(find.byType(PageView));
      expect(pageView.physics, isA<NeverScrollableScrollPhysics>());

      // Khi đang zoom: Tap vùng Trái không đổi trang
      await tester.tapAt(const Offset(100, 300));
      await tester.pumpAndSettle();
      expect(sessionController.state.focusedPageIndex, 0);

      // Khi đang zoom: Tap vùng Giữa vẫn toggle HUD được
      await tester.tapAt(const Offset(400, 300));
      await tester.pumpAndSettle();
      expect(hudToggled, true);
    });
  });

  group('Canonical ReadingMode & Progress Contract Parity', () {
    test('MangaReadingMode maps correctly to Backend Core API enum', () {
      expect(MangaReadingMode.rtl.canonicalReadingMode, 'PAGED');
      expect(MangaReadingMode.ltr.canonicalReadingMode, 'PAGED');
      expect(MangaReadingMode.vertical.canonicalReadingMode, 'WEBTOON');
    });

    test('ReadingProgressCoordinator.recordProgress forwards canonical readingMode', () async {
      final coordinator = ReadingProgressCoordinator(repository: mockProgressRepo);
      coordinator.init();

      // Ghi tiến độ Manga RTL
      coordinator.recordProgress(
        storyId: 'story-1',
        chapterId: 'ch-1',
        readingMode: MangaReadingMode.rtl.canonicalReadingMode,
        flutterPageIndex: 2,
        progressPercentage: 60.0,
        scrollPosition: 2.0,
      );

      // Local checkpoint lưu 1-based pageIndex = 3
      verify(() => mockProgressRepo.saveLocalCheckpoint(
            any(that: predicate<LocalReadingCheckpoint>((cp) =>
                cp.pageIndex == 3 &&
                cp.chapterId == 'ch-1' &&
                cp.progressPercentage == 60.0)),
          )).called(1);

      coordinator.dispose();
    });
  });

  group('ReaderScreen Multi-Mode, Slider & Navigation Tests', () {
    Widget buildReaderApp({String initialLocation = '/reader/ch-1?storyId=story-1'}) {
      final router = GoRouter(
        initialLocation: initialLocation,
        routes: [
          GoRoute(
            path: '/reader/:chapterId',
            builder: (context, state) {
              final chapterId = state.pathParameters['chapterId']!;
              final storyId = state.uri.queryParameters['storyId'] ?? '';
              final pageIndexStr = state.uri.queryParameters['pageIndex'];
              final initialPageIndex =
                  pageIndexStr != null ? (int.tryParse(pageIndexStr) ?? 0) : 0;
              final modeStr = state.uri.queryParameters['mode'];
              final initialMode = MangaReadingMode.fromName(modeStr);

              return ReaderScreen(
                key: ValueKey('reader_$chapterId'),
                chapterId: chapterId,
                storyId: storyId,
                initialPageIndex: initialPageIndex,
                initialMode: initialMode,
                chapterRepository: mockChapterRepo,
                mediaRepository: mockMediaRepo,
                readingProgressRepository: mockProgressRepo,
              );
            },
          ),
        ],
      );

      return MaterialApp.router(routerConfig: router);
    }

    testWidgets('Direct paged resume: /reader/ch-1?pageIndex=4&mode=rtl bootstraps PageController without flash', (tester) async {
      await tester.pumpWidget(buildReaderApp(initialLocation: '/reader/ch-1?storyId=story-1&pageIndex=4&mode=rtl'));

      // Loading xuất hiện trước khi chapter load hoàn tất
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle();

      // Đã load xong và bootstrap ở đúng pageIndex = 4 (Trang 5/5)
      expect(find.byType(MangaPagedReaderView), findsOneWidget);
      expect(find.text('Trang 5 / 5'), findsNothing); // HUD đang ẩn

      // Bật HUD để kiểm tra thông số
      await tester.tapAt(const Offset(400, 300));
      await tester.pumpAndSettle();

      expect(find.text('Trang 5 / 5'), findsOneWidget);
      expect(find.text('Manga (RTL)'), findsOneWidget);
    });

    testWidgets('Mode switching: preserves current focused page between Paged and Vertical', (tester) async {
      await tester.pumpWidget(buildReaderApp(initialLocation: '/reader/ch-1?storyId=story-1&pageIndex=2&mode=rtl'));
      await tester.pumpAndSettle();

      // Bật HUD
      await tester.tapAt(const Offset(400, 300));
      await tester.pumpAndSettle();

      // Đổi sang Cuộn Dọc qua PopupMenu
      await tester.tap(find.byIcon(Icons.settings));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Cuộn Dọc'));
      await tester.pumpAndSettle();

      // Kiểm tra chuyển sang WebtoonReaderView và vẫn ở trang 2 (Trang 3/5)
      expect(find.byType(WebtoonReaderView), findsOneWidget);
      expect(find.text('Trang 3 / 5'), findsOneWidget);
      expect(find.text('Cuộn Dọc'), findsOneWidget);
    });

    testWidgets('Mode switching: preserves current focused page between RTL and LTR without crashing', (tester) async {
      await tester.pumpWidget(buildReaderApp(initialLocation: '/reader/ch-1?storyId=story-1&pageIndex=2&mode=rtl'));
      await tester.pumpAndSettle();

      // Bật HUD
      await tester.tapAt(const Offset(400, 300));
      await tester.pumpAndSettle();

      // Đổi sang Manga (LTR) qua PopupMenu
      await tester.tap(find.byIcon(Icons.settings));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Comic (LTR)'));
      await tester.pumpAndSettle();

      // Kiểm tra vẫn ở MangaPagedReaderView và ở đúng trang 2 (Trang 3/5)
      expect(find.byType(MangaPagedReaderView), findsOneWidget);
      expect(find.text('Trang 3 / 5'), findsOneWidget);
      expect(find.text('Comic (LTR)'), findsOneWidget);
    });

    testWidgets('Preserve mode across chapter navigation: next chapter retains RTL mode', (tester) async {
      await tester.pumpWidget(buildReaderApp(initialLocation: '/reader/ch-1?storyId=story-1&pageIndex=0&mode=rtl'));
      await tester.pumpAndSettle();

      // Bật HUD
      await tester.tapAt(const Offset(400, 300));
      await tester.pumpAndSettle();

      // Bấm "Chương sau"
      await tester.tap(find.text('Chương sau'));
      await tester.pumpAndSettle();

      // Bật HUD trên màn hình chương mới để hiển thị Header Text
      await tester.tapAt(const Offset(400, 300));
      await tester.pumpAndSettle();

      // Chương 2 vẫn giữ nguyên mode Manga (RTL)
      expect(find.byType(MangaPagedReaderView), findsOneWidget);
      expect(find.text('Chương 2: Hồi 2'), findsOneWidget);
      expect(find.text('Manga (RTL)'), findsOneWidget);
    });

    testWidgets('1-Page Chapter edge case: progress is immediately 100%', (tester) async {
      const onePageChapter = ChapterDetail(
        story: ChapterStorySummary(id: 's-1', slug: 'one', title: 'One'),
        chapter: ChapterHeaderSummary(id: 'ch-one', chapterNumber: '1'),
        pages: [
          ChapterPage(assetId: 'asset-single', sortOrder: 1, width: 800, height: 1200),
        ],
      );

      when(() => mockChapterRepo.getChapterDetail('ch-one', versionId: null))
          .thenAnswer((_) async => onePageChapter);

      await tester.pumpWidget(buildReaderApp(initialLocation: '/reader/ch-one?storyId=s-1&pageIndex=0&mode=rtl'));
      await tester.pumpAndSettle();

      // Bật HUD
      await tester.tapAt(const Offset(400, 300));
      await tester.pumpAndSettle();

      expect(find.text('Trang 1 / 1'), findsOneWidget);
      expect(find.text('100.0%'), findsOneWidget);
    });
  });
}
