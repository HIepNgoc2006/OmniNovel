import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/offline/services/offline_content_resolver.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_screen.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart';
import 'package:omninovel_mobile/features/story/presentation/story_detail_screen.dart';
import 'package:omninovel_mobile/features/story/repositories/story_repository.dart';
import 'package:omninovel_mobile/features/studio/models/studio_models.dart';
import 'package:omninovel_mobile/features/studio/presentation/widgets/studio_job_chooser_dialog.dart';
import 'package:omninovel_mobile/features/studio/repositories/studio_repository.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MockStoryRepository extends Mock implements StoryRepository {}
class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}
class MockChapterRepository extends Mock implements ChapterRepository {}
class MockMediaRepository extends Mock implements MediaRepository {}
class MockStudioRepository extends Mock implements StudioRepository {}
class MockOfflineContentResolver extends Mock implements OfflineContentResolver {}

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

  group('Gate 8 & Gate 9: StoryDetailScreen AI Studio Wiring', () {
    late MockStoryRepository mockStoryRepo;
    late MockReadingProgressRepository mockProgressRepo;
    late MockStudioRepository mockStudioRepo;
    late MockOfflineContentResolver mockOfflineResolver;

    const sampleStory = StoryDetail(
      id: 'story-1',
      slug: 'test-story',
      title: 'Truyện Test Studio',
      editions: [
        StoryEdition(
          id: 'ed-1',
          editionName: 'Default',
          isDefault: true,
          chapters: [
            ChapterItemSummary(id: 'ch-1', chapterNumber: '1', title: 'Chương Một'),
            ChapterItemSummary(id: 'ch-2', chapterNumber: '2', title: 'Chương Hai'),
          ],
        ),
      ],
    );

    final job1 = TranslationJobSummaryDto(
      id: 'job-101',
      chapterId: 'ch-1',
      chapterNumber: '1',
      targetLanguage: 'vi',
      status: TranslationJobStatus.readyForReview,
      modelName: 'gpt-4o',
      completedAt: DateTime.parse('2026-09-28T10:00:00Z'),
    );

    final job2 = TranslationJobSummaryDto(
      id: 'job-102',
      chapterId: 'ch-1',
      chapterNumber: '1',
      targetLanguage: 'en',
      status: TranslationJobStatus.readyForReview,
      modelName: 'claude-3-5-sonnet',
      completedAt: DateTime.parse('2026-09-28T11:00:00Z'),
    );

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      mockStoryRepo = MockStoryRepository();
      mockProgressRepo = MockReadingProgressRepository();
      mockStudioRepo = MockStudioRepository();
      mockOfflineResolver = MockOfflineContentResolver();

      when(() => mockStoryRepo.getStoryBySlug(sampleStory.slug)).thenAnswer((_) async => sampleStory);
      when(() => mockProgressRepo.getLocalCheckpoint(any())).thenAnswer((_) async => null);
      when(() => mockProgressRepo.getProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(
          storyId: 'story-1',
          chapterId: 'ch-1',
          readChapterIds: [],
          writeEpoch: 1,
        ),
      );
    });

    testWidgets('shows [Duyệt AI] badge for chapters that have READY_FOR_REVIEW jobs', (tester) async {
      when(() => mockStudioRepo.getJobsByChapterForStory('story-1')).thenAnswer(
        (_) async => {
          'ch-1': [job1],
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          home: StoryDetailScreen(
            slug: sampleStory.slug,
            storyRepository: mockStoryRepo,
            readingProgressRepository: mockProgressRepo,
            studioRepository: mockStudioRepo,
            offlineResolver: mockOfflineResolver,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Chapter 1 có badge Duyệt AI
      expect(find.text('Duyệt AI'), findsOneWidget);
      // Chapter 2 không có job nên chỉ có 1 badge
      expect(find.text('Chương 1: Chương Một'), findsOneWidget);
      expect(find.text('Chương 2: Chương Hai'), findsOneWidget);
    });

    testWidgets('opens StudioJobChooserDialog when chapter has multiple ready AI jobs', (tester) async {
      when(() => mockStudioRepo.getJobsByChapterForStory('story-1')).thenAnswer(
        (_) async => {
          'ch-1': [job1, job2],
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          home: StoryDetailScreen(
            slug: sampleStory.slug,
            storyRepository: mockStoryRepo,
            readingProgressRepository: mockProgressRepo,
            studioRepository: mockStudioRepo,
            offlineResolver: mockOfflineResolver,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Nhấn vào badge Duyệt AI của Chapter 1
      final badgeFinder = find.text('Duyệt AI');
      expect(badgeFinder, findsOneWidget);
      await tester.tap(badgeFinder);
      await tester.pumpAndSettle();

      // Hiện dialog StudioJobChooserDialog
      expect(find.byType(StudioJobChooserDialog), findsOneWidget);
      expect(find.text('Chọn bản dịch AI cần duyệt'), findsOneWidget);
      expect(find.textContaining('gpt-4o'), findsOneWidget);
      expect(find.textContaining('claude-3-5-sonnet'), findsOneWidget);
    });
  });

  group('Gate 8 & Gate 9: ReaderScreen AI Studio Wiring', () {
    late MockChapterRepository mockChapterRepo;
    late MockMediaRepository mockMediaRepo;
    late MockReadingProgressRepository mockProgressRepo;
    late MockStudioRepository mockStudioRepo;
    late MockOfflineContentResolver mockOfflineResolver;

    const sampleChapterDetail = ChapterDetail(
      chapter: ChapterHeaderSummary(
        id: 'ch-1',
        storyEditionId: 'ed-1',
        chapterNumber: '1',
        title: 'Chương 1',
        activeVersionId: 'v1',
      ),
      story: ChapterStorySummary(
        id: 'story-1',
        slug: 'story-1',
        title: 'Truyện Đang Đọc',
        mediaFormat: 'COMIC',
      ),
      activeVersion: ChapterVersionInfo(
        id: 'v1',
        versionNumber: 1,
        versionType: 'TRANSLATION',
        isPublished: true,
      ),
      pages: [
        ChapterPage(assetId: 'page-1', sortOrder: 0),
      ],
      availableVersions: [],
    );

    final job1 = TranslationJobSummaryDto(
      id: 'job-101',
      chapterId: 'ch-1',
      chapterNumber: '1',
      targetLanguage: 'vi',
      status: TranslationJobStatus.readyForReview,
      modelName: 'gpt-4o',
      completedAt: DateTime.parse('2026-09-28T10:00:00Z'),
    );

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      mockChapterRepo = MockChapterRepository();
      mockMediaRepo = MockMediaRepository();
      mockProgressRepo = MockReadingProgressRepository();
      mockStudioRepo = MockStudioRepository();
      mockOfflineResolver = MockOfflineContentResolver();

      when(() => mockChapterRepo.getChapterDetail('ch-1', versionId: any(named: 'versionId')))
          .thenAnswer((_) async => sampleChapterDetail);
      when(() => mockMediaRepo.getMediaDownloadUrl(any(), forceRefresh: any(named: 'forceRefresh')))
          .thenAnswer((_) async => 'https://example.com/asset.jpg');
      when(() => mockMediaRepo.getMediaDownloadUrl(any()))
          .thenAnswer((_) async => 'https://example.com/asset.jpg');
      when(() => mockProgressRepo.getLocalCheckpoint(any())).thenAnswer((_) async => null);
      when(() => mockProgressRepo.getProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 'story-1', writeEpoch: 1),
      );
      when(() => mockProgressRepo.saveLocalCheckpoint(any())).thenAnswer((_) async {});
      when(() => mockProgressRepo.getLocalGeneration(any())).thenReturn(0);
      when(() => mockProgressRepo.getCachedServerEpoch(any())).thenReturn(0);
      when(() => mockProgressRepo.ensureServerEpoch(any())).thenAnswer((_) async => 0);
      when(() => mockProgressRepo.saveProgress(any()))
          .thenAnswer((_) async => const ReadingProgressResponse(storyId: 'story-1', writeEpoch: 1));
    });

    testWidgets('ReaderScreen shows AI action button in Top Overlay when chapter has ready AI jobs', (tester) async {
      when(() => mockStudioRepo.getJobsByChapterForStory('story-1')).thenAnswer(
        (_) async => {
          'ch-1': [job1],
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          home: ReaderScreen(
            chapterId: 'ch-1',
            storyId: 'story-1',
            chapterRepository: mockChapterRepo,
            mediaRepository: mockMediaRepo,
            readingProgressRepository: mockProgressRepo,
            studioRepository: mockStudioRepo,
            offlineContentResolver: mockOfflineResolver,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Ban đầu overlay chưa bật -> tap vào màn hình để bật overlay
      await tester.tap(find.byType(ReaderScreen));
      await tester.pumpAndSettle();

      // Nút Duyệt bản dịch AI mới (Icons.auto_awesome) xuất hiện
      expect(find.byTooltip('Duyệt bản dịch AI mới'), findsOneWidget);
    });

    testWidgets('ReaderScreen hides AI action button when chapter has no ready jobs', (tester) async {
      when(() => mockStudioRepo.getJobsByChapterForStory('story-1')).thenAnswer(
        (_) async => {
          'ch-1': [],
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          home: ReaderScreen(
            chapterId: 'ch-1',
            storyId: 'story-1',
            chapterRepository: mockChapterRepo,
            mediaRepository: mockMediaRepo,
            readingProgressRepository: mockProgressRepo,
            studioRepository: mockStudioRepo,
            offlineContentResolver: mockOfflineResolver,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Tap để bật overlay
      await tester.tap(find.byType(ReaderScreen));
      await tester.pumpAndSettle();

      // Nút Duyệt bản dịch AI mới KHÔNG xuất hiện
      expect(find.byTooltip('Duyệt bản dịch AI mới'), findsNothing);
    });
  });
}
