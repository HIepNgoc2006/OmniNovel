import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/gamification/models/gamification_models.dart';
import 'package:omninovel_mobile/features/gamification/repositories/gamification_repository.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reading_progress_coordinator.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';

class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}
class MockGamificationRepository extends Mock implements GamificationRepository {}

class FakeStopwatch implements Stopwatch {
  Duration _elapsed = Duration.zero;
  bool _isRunning = false;

  void setElapsed(Duration d) => _elapsed = d;

  @override
  Duration get elapsed => _elapsed;

  @override
  int get elapsedMicroseconds => _elapsed.inMicroseconds;

  @override
  int get elapsedMilliseconds => _elapsed.inMilliseconds;

  @override
  int get elapsedTicks => _elapsed.inMicroseconds;

  @override
  int get frequency => 1000000;

  @override
  bool get isRunning => _isRunning;

  @override
  void reset() {
    _elapsed = Duration.zero;
  }

  @override
  void start() {
    _isRunning = true;
  }

  @override
  void stop() {
    _isRunning = false;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockReadingProgressRepository mockProgressRepo;
  late MockGamificationRepository mockGamificationRepo;
  late ReadingProgressCoordinator coordinator;

  setUpAll(() {
    registerFallbackValue(
      const ReadingProgressPayload(
        storyId: 's1',
        chapterId: 'c1',
        pageIndex: 1,
        progressPercentage: 0,
        scrollPosition: 0,
        writeEpoch: 0,
      ),
    );
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
  });

  setUp(() {
    mockProgressRepo = MockReadingProgressRepository();
    mockGamificationRepo = MockGamificationRepository();

    when(() => mockProgressRepo.ensureServerEpoch(any())).thenAnswer((_) async => 0);
    when(() => mockProgressRepo.getCachedServerEpoch(any())).thenReturn(0);
    when(() => mockProgressRepo.getLocalGeneration(any())).thenReturn(0);
    when(() => mockProgressRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => {});

    coordinator = ReadingProgressCoordinator(
      repository: mockProgressRepo,
      gamificationRepository: mockGamificationRepo,
      debounceDuration: const Duration(milliseconds: 50),
    );
  });

  tearDown(() {
    coordinator.dispose();
  });

  group('Gate 9 & Gate 9B: Reading Reward Coordinator Tests', () {
    test('Reward requires both duration >= 45s AND progress >= 80%', () async {
      final fakeStopwatch = FakeStopwatch();
      coordinator.onChapterReady('c1');
      coordinator.setActiveReadingStopwatchForTesting(fakeStopwatch);

      // Case 1: duration < 45s (30s), progress >= 80% (85%)
      fakeStopwatch.setElapsed(const Duration(seconds: 30));
      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 10,
        scrollPosition: 1000.0,
        progressPercentage: 85.0,
      );
      verifyNever(() => mockGamificationRepo.rewardReadChapter(
            chapterId: any(named: 'chapterId'),
            readingDurationSeconds: any(named: 'readingDurationSeconds'),
            progressPercentage: any(named: 'progressPercentage'),
          ));

      // Case 2: duration >= 45s (50s), progress < 80% (75%)
      fakeStopwatch.setElapsed(const Duration(seconds: 50));
      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 10,
        scrollPosition: 1000.0,
        progressPercentage: 75.0,
      );
      verifyNever(() => mockGamificationRepo.rewardReadChapter(
            chapterId: any(named: 'chapterId'),
            readingDurationSeconds: any(named: 'readingDurationSeconds'),
            progressPercentage: any(named: 'progressPercentage'),
          ));

      // Case 3: duration >= 45s (50s) AND progress >= 80% (85%) -> triggers reward
      when(() => mockGamificationRepo.rewardReadChapter(
            chapterId: 'c1',
            readingDurationSeconds: 50,
            progressPercentage: 85.0,
          )).thenAnswer((_) async => const ReadChapterRewardResult(
            success: true,
            earnedExp: 10,
            reason: 'SUCCESS',
            serverDateVN: '2026-09-24',
          ));

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 10,
        scrollPosition: 1000.0,
        progressPercentage: 85.0,
      );

      await Future<void>.delayed(const Duration(milliseconds: 10));
      verify(() => mockGamificationRepo.rewardReadChapter(
            chapterId: 'c1',
            readingDurationSeconds: 50,
            progressPercentage: 85.0,
          )).called(1);

      expect(coordinator.rewardedChapters.contains('c1'), isTrue);
      expect(coordinator.currentServerDateVN, '2026-09-24');
    });

    test('App lifecycle pause stops stopwatch, resume restarts it', () {
      final fakeStopwatch = FakeStopwatch()..start();
      coordinator.onChapterReady('c1');
      coordinator.setActiveReadingStopwatchForTesting(fakeStopwatch);
      expect(fakeStopwatch.isRunning, isTrue);

      // App goes to background
      coordinator.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(fakeStopwatch.isRunning, isFalse);

      // App returns to foreground
      coordinator.didChangeAppLifecycleState(AppLifecycleState.resumed);
      expect(fakeStopwatch.isRunning, isTrue);
    });

    test('ALREADY_REWARDED adds chapter to rewarded list preventing further calls', () async {
      final fakeStopwatch = FakeStopwatch();
      fakeStopwatch.setElapsed(const Duration(seconds: 60));
      coordinator.onChapterReady('c1');
      coordinator.setActiveReadingStopwatchForTesting(fakeStopwatch);

      when(() => mockGamificationRepo.rewardReadChapter(
            chapterId: 'c1',
            readingDurationSeconds: 60,
            progressPercentage: 90.0,
          )).thenAnswer((_) async => const ReadChapterRewardResult(
            success: false,
            earnedExp: 0,
            reason: 'ALREADY_REWARDED',
            serverDateVN: '2026-09-24',
          ));

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 10,
        scrollPosition: 1000.0,
        progressPercentage: 90.0,
      );

      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(coordinator.rewardedChapters.contains('c1'), isTrue);

      // Subsequent progress in same chapter must be ignored
      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 11,
        scrollPosition: 1100.0,
        progressPercentage: 95.0,
      );

      verify(() => mockGamificationRepo.rewardReadChapter(
            chapterId: 'c1',
            readingDurationSeconds: 60,
            progressPercentage: 90.0,
          )).called(1);
    });

    test('Gate 9 & Gate 9B: DAILY_CAP_REACHED binds serverDateVN and suppresses calls without local clock fallback',
        () async {
      final fakeStopwatch = FakeStopwatch();
      fakeStopwatch.setElapsed(const Duration(seconds: 60));
      coordinator.onChapterReady('c1');
      coordinator.setActiveReadingStopwatchForTesting(fakeStopwatch);

      // Server returns DAILY_CAP_REACHED with canonical VN date
      when(() => mockGamificationRepo.rewardReadChapter(
            chapterId: 'c1',
            readingDurationSeconds: 60,
            progressPercentage: 85.0,
          )).thenAnswer((_) async => const ReadChapterRewardResult(
            success: false,
            earnedExp: 0,
            reason: 'DAILY_CAP_REACHED',
            serverDateVN: '2026-09-24',
          ));

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 10,
        scrollPosition: 1000.0,
        progressPercentage: 85.0,
      );

      await Future<void>.delayed(const Duration(milliseconds: 10));

      // CRITICAL Gate 9 Invariant: DO NOT add to _rewardedChapters!
      expect(coordinator.rewardedChapters.contains('c1'), isFalse);
      // Bound precisely to serverDateVN
      expect(coordinator.dailyReadCapReachedDate, '2026-09-24');
      expect(coordinator.currentServerDateVN, '2026-09-24');

      // Gate 9B Invariant: Reading next chapter (c2) on same server date is suppressed locally
      coordinator.onChapterReady('c2');
      coordinator.setActiveReadingStopwatchForTesting(fakeStopwatch);
      fakeStopwatch.setElapsed(const Duration(seconds: 60));

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c2',
        flutterPageIndex: 10,
        scrollPosition: 1000.0,
        progressPercentage: 90.0,
      );

      // Never dispatched HTTP request for c2 because of daily suppression
      verifyNever(() => mockGamificationRepo.rewardReadChapter(
            chapterId: 'c2',
            readingDurationSeconds: any(named: 'readingDurationSeconds'),
            progressPercentage: any(named: 'progressPercentage'),
          ));

      // Gate 9 rollover test: New day arrived via server progression / sync
      coordinator.updateServerDateVN('2026-09-25');
      expect(coordinator.dailyReadCapReachedDate, isNull);

      // Chapter c1 (which wasn't marked rewarded yesterday) can now trigger reward today
      when(() => mockGamificationRepo.rewardReadChapter(
            chapterId: 'c1',
            readingDurationSeconds: 60,
            progressPercentage: 85.0,
          )).thenAnswer((_) async => const ReadChapterRewardResult(
            success: true,
            earnedExp: 10,
            reason: 'SUCCESS',
            serverDateVN: '2026-09-25',
          ));

      coordinator.onChapterReady('c1');
      coordinator.setActiveReadingStopwatchForTesting(fakeStopwatch);
      fakeStopwatch.setElapsed(const Duration(seconds: 60));

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 10,
        scrollPosition: 1000.0,
        progressPercentage: 85.0,
      );

      await Future<void>.delayed(const Duration(milliseconds: 10));
      verify(() => mockGamificationRepo.rewardReadChapter(
            chapterId: 'c1',
            readingDurationSeconds: 60,
            progressPercentage: 85.0,
          )).called(2);

      expect(coordinator.rewardedChapters.contains('c1'), isTrue);
    });
  });
}
