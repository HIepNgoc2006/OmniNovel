import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/chapter_report_sheet.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_screen.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_report_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MockAuthService extends Mock implements AuthService {}
class MockChapterRepository extends Mock implements ChapterRepository {}
class MockMediaRepository extends Mock implements MediaRepository {}
class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}
class MockChapterReportRepository extends Mock implements ChapterReportRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    registerFallbackValue(
      LocalReadingCheckpoint(
        storyId: 's1',
        chapterId: 'c1',
        pageIndex: 1,
        progressPercentage: 0,
        scrollPosition: 0,
        updatedAt: DateTime.now(),
      ),
    );
    registerFallbackValue(
      const ReadingProgressPayload(
        chapterId: 'c1',
        progressPercentage: 0,
        scrollPosition: 0,
        writeEpoch: 0,
      ),
    );
  });

  late MockAuthService mockAuthService;
  late MockChapterRepository mockChapterRepo;
  late MockMediaRepository mockMediaRepo;
  late MockReadingProgressRepository mockProgressRepo;
  late MockChapterReportRepository mockReportRepo;

  const sampleChapterDetail = ChapterDetail(
    chapter: ChapterHeaderSummary(
      id: 'ch-1',
      storyEditionId: 'ed-1',
      chapterNumber: '1',
      title: 'Chương 1',
      activeVersionId: 'canonical-active-v1', // Khác với rendered version để assert Gate 6
    ),
    activeVersion: ChapterVersionInfo(
      id: 'rendered-version-v2', // Rendered version thực tế
      versionNumber: 2,
      versionType: 'TRANSLATION',
      isPublished: true,
    ),
    story: ChapterStorySummary(
      id: 'story-1',
      slug: 'story-1',
      title: 'Truyện Test',
      mediaFormat: 'COMIC',
    ),
    pages: [
      ChapterPage(assetId: 'asset-1', sortOrder: 0),
    ],
    availableVersions: [],
  );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    mockAuthService = MockAuthService();
    mockChapterRepo = MockChapterRepository();
    mockMediaRepo = MockMediaRepository();
    mockProgressRepo = MockReadingProgressRepository();
    mockReportRepo = MockChapterReportRepository();

    when(() => mockChapterRepo.getChapterDetail(any(), versionId: any(named: 'versionId')))
        .thenAnswer((_) async => sampleChapterDetail);
    when(() => mockMediaRepo.getMediaDownloadUrl(any(), forceRefresh: any(named: 'forceRefresh')))
        .thenAnswer((_) async => 'https://example.com/asset-1.jpg');
    when(() => mockMediaRepo.getMediaDownloadUrl(any()))
        .thenAnswer((_) async => 'https://example.com/asset-1.jpg');
    when(() => mockProgressRepo.saveLocalCheckpoint(any()))
        .thenAnswer((_) async {});
    when(() => mockProgressRepo.getLocalCheckpoint(any()))
        .thenAnswer((_) async => null);
    when(() => mockProgressRepo.getProgress(any()))
        .thenAnswer((_) async => const ReadingProgressResponse(storyId: 'story-1', writeEpoch: 1));
    when(() => mockProgressRepo.getLocalGeneration(any())).thenReturn(0);
    when(() => mockProgressRepo.getCachedServerEpoch(any())).thenReturn(0);
    when(() => mockProgressRepo.ensureServerEpoch(any())).thenAnswer((_) async => 0);
    when(() => mockProgressRepo.saveProgress(any()))
        .thenAnswer((_) async => const ReadingProgressResponse(storyId: 'story-1', writeEpoch: 1));
  });

  Widget buildReaderScreen() {
    return MaterialApp(
      home: ReaderScreen(
        chapterId: 'ch-1',
        storyId: 'story-1',
        chapterRepository: mockChapterRepo,
        mediaRepository: mockMediaRepo,
        readingProgressRepository: mockProgressRepo,
        authService: mockAuthService,
        reportRepository: mockReportRepo,
      ),
    );
  }

  group('ReaderScreen Report Gates (Gate 6 & Gate 7)', () {
    testWidgets('Gate 7: Guest User -> Bấm nút báo lỗi -> Hiển thị login dialog, ZERO report API calls', (tester) async {
      when(() => mockAuthService.state).thenReturn(
        const AuthState(status: AuthStatus.unauthenticated),
      );

      await tester.pumpWidget(buildReaderScreen());
      await tester.pumpAndSettle();

      // Mở overlay HUD bằng cách tap vào màn hình
      await tester.tap(find.byType(ReaderScreen));
      await tester.pumpAndSettle();

      // Tìm nút cờ Báo lỗi
      final flagButton = find.byIcon(Icons.flag_outlined);
      expect(flagButton, findsOneWidget);

      await tester.tap(flagButton);
      await tester.pumpAndSettle();

      // Phải xuất hiện Dialog yêu cầu đăng nhập
      expect(find.text('Yêu cầu đăng nhập'), findsOneWidget);
      expect(
        find.text('Bạn cần đăng nhập tài khoản để gửi báo cáo lỗi chương truyện.'),
        findsOneWidget,
      );

      // Tuyệt đối không có bất kỳ API call nào tới reportRepository
      verifyZeroInteractions(mockReportRepo);
    });

    testWidgets('Gate 6 & 7: Authenticated User -> Mở ChapterReportSheet bind đúng rendered version ID', (tester) async {
      when(() => mockAuthService.state).thenReturn(
        const AuthState(
          status: AuthStatus.authenticated,
          user: User(id: 'u-1', email: 'test@example.com', username: 'tester', role: 'READER'),
        ),
      );

      await tester.pumpWidget(buildReaderScreen());
      await tester.pumpAndSettle();

      // Mở overlay HUD
      await tester.tap(find.byType(ReaderScreen));
      await tester.pumpAndSettle();

      // Bấm nút cờ Báo lỗi
      final flagButton = find.byIcon(Icons.flag_outlined);
      expect(flagButton, findsOneWidget);

      await tester.tap(flagButton);
      await tester.pumpAndSettle();

      // Không hiển thị login dialog
      expect(find.text('Yêu cầu đăng nhập'), findsNothing);

      // Phải mở ChapterReportSheet với đúng rendered version ('rendered-version-v2'), không phải 'canonical-active-v1'
      final sheetFinder = find.byType(ChapterReportSheet);
      expect(sheetFinder, findsOneWidget);

      final sheetWidget = tester.widget<ChapterReportSheet>(sheetFinder);
      expect(sheetWidget.chapterVersionId, 'rendered-version-v2');
      expect(sheetWidget.mediaFormat, 'COMIC');
    });
  });
}
