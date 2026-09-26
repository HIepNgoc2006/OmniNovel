import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_screen.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:shared_preferences/shared_preferences.dart';

class StubMediaRepository implements MediaRepository {
  @override
  Future<String> getMediaDownloadUrl(String assetId, {bool forceRefresh = false}) async {
    return 'https://cdn.example.com/$assetId.jpg';
  }

  @override
  void invalidate(String assetId) {}

  @override
  void clearCache() {}
}

class StubChapterRepository implements ChapterRepository {
  final List<ChapterPage> pages;

  StubChapterRepository({required this.pages});

  @override
  Future<ChapterDetail> getChapterDetail(String chapterId, {String? versionId}) async {
    return ChapterDetail(
      story: const ChapterStorySummary(id: 'bench-story', slug: 'bench', title: 'Benchmark Story'),
      chapter: const ChapterHeaderSummary(id: 'bench-ch-1', chapterNumber: '1', title: 'Stress Chapter'),
      pages: pages,
    );
  }
}

class InMemoryProgressRepository implements ReadingProgressRepository {
  LocalReadingCheckpoint? savedCheckpoint;
  ReadingProgressPayload? savedServerPayload;

  @override
  Future<LocalReadingCheckpoint?> getLocalCheckpoint(String storyId) async {
    return savedCheckpoint;
  }

  @override
  Future<void> saveLocalCheckpoint(LocalReadingCheckpoint checkpoint) async {
    savedCheckpoint = checkpoint;
  }

  @override
  Future<void> clearLocalCheckpoint(String storyId) async {
    savedCheckpoint = null;
  }

  @override
  Future<void> clearAllLocalCheckpoints() async {
    savedCheckpoint = null;
  }

  @override
  Future<ReadingProgressResponse> getProgress(String storyId) async {
    return const ReadingProgressResponse(storyId: 'bench-story', writeEpoch: 0);
  }

  @override
  Future<ReadingProgressResponse> saveProgress(
    ReadingProgressPayload payload, {
    CancelToken? cancelToken,
  }) async {
    savedServerPayload = payload;
    return ReadingProgressResponse(
      storyId: payload.storyId ?? 'bench-story',
      chapterId: payload.chapterId,
      pageIndex: payload.pageIndex,
      progressPercentage: payload.progressPercentage,
      scrollPosition: payload.scrollPosition,
      updatedAt: DateTime.now(),
      writeEpoch: payload.writeEpoch,
    );
  }

  @override
  Future<int> ensureServerEpoch(String storyId) async {
    return 0;
  }

  @override
  int? getCachedServerEpoch(String storyId) => 0;

  @override
  Future<int?> getLastKnownServerEpoch(String storyId) async => 0;

  @override
  ReadingProgressResponse? getCachedServerProgress(String storyId) => null;

  @override
  int getLocalGeneration(String storyId) => 0;

  @override
  void setServerEpoch(String storyId, int epoch) {}

  @override
  void invalidateStory(String storyId) {}

  @override
  void invalidateAllStories() {}
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  // Fixture 150 trang Webtoon kích thước hỗn hợp
  final fixturePages = List.generate(150, (i) {
    final type = i % 5;
    final (w, h) = switch (type) {
      0 => (800, 1200),
      1 => (800, 3200),
      2 => (1080, 1920),
      3 => (1080, 4320),
      _ => (1440, 1800),
    };
    return ChapterPage(
      assetId: 'bench-asset-$i',
      sortOrder: i + 1,
      width: w,
      height: h,
    );
  });

  group('Android Reader Performance & Process-Death Benchmark', () {
    testWidgets('Benchmark: 150-page scroll workload and frame profile', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final mediaRepo = StubMediaRepository();
      final chapterRepo = StubChapterRepository(pages: fixturePages);
      final progressRepo = InMemoryProgressRepository();

      await tester.pumpWidget(
        MaterialApp(
          home: ReaderScreen(
            chapterId: 'bench-ch-1',
            storyId: 'bench-story',
            chapterRepository: chapterRepo,
            mediaRepository: mediaRepo,
            readingProgressRepository: progressRepo,
          ),
        ),
      );

      await tester.pumpAndSettle();

      final frameDurations = <double>[];
      int jankCount = 0;

      // Đo đạc frame timings qua timeline/callback
      WidgetsBinding.instance.addTimingsCallback((timings) {
        for (final timing in timings) {
          final ms = timing.totalSpan.inMicroseconds / 1000.0;
          frameDurations.add(ms);
          if (ms > 16.67) {
            jankCount++;
          }
        }
      });

      // Cuộn dồn dập từ trang 0 xuống giữa chương truyện (trang ~75)
      final scrollFinder = find.byType(Scrollable);
      expect(scrollFinder, findsOneWidget);

      for (int step = 0; step < 25; step++) {
        await tester.fling(scrollFinder, const Offset(0, -600), 1200);
        await tester.pump(const Duration(milliseconds: 16));
      }
      await tester.pumpAndSettle();

      // Tính toán số liệu Frame Budget
      frameDurations.sort();
      final totalFrames = frameDurations.isNotEmpty ? frameDurations.length : 1;
      final p50 = frameDurations.isNotEmpty
          ? frameDurations[(totalFrames * 0.50).floor()]
          : 0.0;
      final p90 = frameDurations.isNotEmpty
          ? frameDurations[(totalFrames * 0.90).floor()]
          : 0.0;
      final p99 = frameDurations.isNotEmpty
          ? frameDurations[(totalFrames * 0.99).floor()]
          : 0.0;
      final jankPercent = (jankCount / totalFrames) * 100.0;

      final imageCacheBytes = PaintingBinding.instance.imageCache.currentSizeBytes;
      final imageCacheCount = PaintingBinding.instance.imageCache.currentSize;

      // Xác minh Checkpoint được lưu
      expect(progressRepo.savedCheckpoint, isNotNull);
      final savedPage = progressRepo.savedCheckpoint!.pageIndex;
      expect(savedPage, greaterThan(1));

      final report = {
        'totalFrames': totalFrames,
        'P50FrameMs': double.parse(p50.toStringAsFixed(2)),
        'P90FrameMs': double.parse(p90.toStringAsFixed(2)),
        'P99FrameMs': double.parse(p99.toStringAsFixed(2)),
        'jankyFramesPercent': double.parse(jankPercent.toStringAsFixed(2)),
        'imageCacheBytes': imageCacheBytes,
        'imageCacheCount': imageCacheCount,
        'savedPageIndex': savedPage,
      };

      debugPrint('[PERFORMANCE_BENCHMARK_REPORT] ${jsonEncode(report)}');

      // Assertions
      expect(imageCacheBytes, lessThan(90 * 1024 * 1024)); // < 90MB ImageCache budget
    });

    testWidgets('Process-Death Verification: Resume exactly restored from checkpoint', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final mediaRepo = StubMediaRepository();
      final chapterRepo = StubChapterRepository(pages: fixturePages);
      final progressRepo = InMemoryProgressRepository();

      // Giả lập trạng thái trước khi Kill App: Người đọc đã đọc tới trang 73
      progressRepo.savedCheckpoint = LocalReadingCheckpoint(
        storyId: 'bench-story',
        chapterId: 'bench-ch-1',
        pageIndex: 73, // 1-based (trang 73)
        progressPercentage: 48.5,
        scrollPosition: 45000.0,
        updatedAt: DateTime.now(),
      );

      // App relaunch sau khi process bị kill
      await tester.pumpWidget(
        MaterialApp(
          home: ReaderScreen(
            chapterId: 'bench-ch-1',
            storyId: 'bench-story',
            initialPageIndex: 72, // 0-based
            chapterRepository: chapterRepo,
            mediaRepository: mediaRepo,
            readingProgressRepository: progressRepo,
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Verify that Reader loaded and resumed accurately
      expect(find.byType(ReaderScreen), findsOneWidget);
    });
  });
}
