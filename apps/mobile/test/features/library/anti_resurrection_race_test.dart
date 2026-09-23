import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reading_progress_coordinator.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';

class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockReadingProgressRepository mockRepo;
  late ReadingProgressCoordinator coordinator;

  setUpAll(() {
    registerFallbackValue(
      const ReadingProgressPayload(
        storyId: 'story-1',
        chapterId: 'ch-1',
        pageIndex: 1,
        progressPercentage: 0,
        scrollPosition: 0,
        writeEpoch: 0,
      ),
    );
    registerFallbackValue(
      LocalReadingCheckpoint(
        storyId: 'story-1',
        chapterId: 'ch-1',
        pageIndex: 1,
        progressPercentage: 0,
        scrollPosition: 0,
        updatedAt: DateTime.now(),
      ),
    );
  });

  setUp(() {
    mockRepo = MockReadingProgressRepository();
    when(() => mockRepo.ensureServerEpoch(any())).thenAnswer((_) async => 0);
    when(() => mockRepo.getCachedServerEpoch(any())).thenReturn(0);
    when(() => mockRepo.getLocalGeneration(any())).thenReturn(0);
    when(() => mockRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => {});
    coordinator = ReadingProgressCoordinator(
      repository: mockRepo,
      debounceDuration: const Duration(milliseconds: 150),
    );
  });

  tearDown(() {
    coordinator.dispose();
  });

  group('Anti-Resurrection Concurrency Tests (Gate 6C-6F)', () {
    test('Gate 6C: In-flight write to deleted story receives STALE_WRITE_EPOCH, drops payload and halts sync', () async {
      when(() => mockRepo.ensureServerEpoch('story-1')).thenAnswer((_) async => 0);
      await coordinator.startSession('story-1');

      // Setup server rejecting stale epoch (tombstone exists on server)
      when(() => mockRepo.saveProgress(any())).thenThrow(
        const StaleWriteEpochException(storyId: 'story-1', writeEpoch: 0, currentEpoch: 1),
      );

      coordinator.recordProgress(
        storyId: 'story-1',
        chapterId: 'ch-1',
        flutterPageIndex: 3,
        progressPercentage: 40.0,
        scrollPosition: 1200.0,
      );

      // Trigger flush
      await coordinator.flush();

      // Sync must be disabled
      expect(coordinator.isServerSyncEnabled, isFalse);

      // Verify that no automatic retry happened with the new epoch 1 (Anti-Promotion invariant)
      verify(() => mockRepo.saveProgress(any())).called(1);

      // Subsequent scroll events must NOT reach the network
      coordinator.recordProgress(
        storyId: 'story-1',
        chapterId: 'ch-1',
        flutterPageIndex: 4,
        progressPercentage: 50.0,
        scrollPosition: 1500.0,
      );
      await Future<void>.delayed(const Duration(milliseconds: 200));

      verifyNever(() => mockRepo.saveProgress(any(
            that: isA<ReadingProgressPayload>().having((p) => p.writeEpoch, 'writeEpoch', 1),
          )));
    });

    test('Gate 6D: In-flight write to any story after clearAll receives STALE_WRITE_EPOCH and drops', () async {
      when(() => mockRepo.ensureServerEpoch('story-any')).thenAnswer((_) async => 3);
      when(() => mockRepo.getCachedServerEpoch('story-any')).thenReturn(3);
      await coordinator.startSession('story-any');

      // clearAll advanced global epoch to 4 on server
      when(() => mockRepo.saveProgress(any())).thenThrow(
        const StaleWriteEpochException(storyId: 'story-any', writeEpoch: 3, currentEpoch: 4),
      );

      coordinator.recordProgress(
        storyId: 'story-any',
        chapterId: 'ch-9',
        flutterPageIndex: 1,
        progressPercentage: 15.0,
        scrollPosition: 500.0,
      );

      await coordinator.flush();

      expect(coordinator.isServerSyncEnabled, isFalse);
      verify(() => mockRepo.saveProgress(any())).called(1);
    });

    test('Gate 6E: Late binding draft materialization binds epoch at transmission time, not creation time', () async {
      // Mock ensureServerEpoch returning epoch 7
      when(() => mockRepo.ensureServerEpoch('story-late')).thenAnswer((_) async => 7);
      when(() => mockRepo.getCachedServerEpoch('story-late')).thenReturn(7);
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 'story-late', writeEpoch: 7),
      );

      await coordinator.startSession('story-late');

      // User creates progress draft
      coordinator.recordProgress(
        storyId: 'story-late',
        chapterId: 'ch-2',
        flutterPageIndex: 5,
        progressPercentage: 60.0,
        scrollPosition: 2000.0,
      );

      // Flush to materialize and push
      await coordinator.flush();

      // The sent payload must have writeEpoch == 7
      verify(() => mockRepo.saveProgress(any(
            that: isA<ReadingProgressPayload>()
                .having((p) => p.writeEpoch, 'writeEpoch', 7)
                .having((p) => p.storyId, 'storyId', 'story-late'),
          ))).called(1);
    });

    test('Gate 6F: Pre-hydration draft queue buffers checkpoint locally and dispatches only after epoch is resolved', () async {
      var epochResolved = false;
      when(() => mockRepo.ensureServerEpoch('story-queue')).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        epochResolved = true;
        when(() => mockRepo.getCachedServerEpoch('story-queue')).thenReturn(10);
        return 10;
      });
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 'story-queue', writeEpoch: 10),
      );

      // Start session without awaiting
      final sessionFuture = coordinator.startSession('story-queue');
      expect(epochResolved, isFalse);

      // User scrolls during hydration
      coordinator.recordProgress(
        storyId: 'story-queue',
        chapterId: 'ch-first',
        flutterPageIndex: 0,
        progressPercentage: 5.0,
        scrollPosition: 100.0,
      );

      // Local checkpoint is saved immediately
      verify(() => mockRepo.saveLocalCheckpoint(any())).called(1);

      // Network must NOT be touched yet
      verifyNever(() => mockRepo.saveProgress(any()));

      // Await hydration completion
      await sessionFuture;
      expect(epochResolved, isTrue);

      // Wait for debounce flush
      await Future<void>.delayed(const Duration(milliseconds: 250));

      // Network was pushed with hydrated epoch 10
      verify(() => mockRepo.saveProgress(any(
            that: isA<ReadingProgressPayload>().having((p) => p.writeEpoch, 'writeEpoch', 10),
          ))).called(1);
    });

    test('Gate 6G: Failed hydration must NOT seed epoch zero and must not dispatch network payload', () async {
      // 1. Server getProgress fails (network drop / offline)
      when(() => mockRepo.ensureServerEpoch('story-offline')).thenThrow(
        Exception('Network connectivity offline'),
      );
      when(() => mockRepo.getCachedServerEpoch('story-offline')).thenReturn(null);

      // Start reading session
      await coordinator.startSession('story-offline');

      // Verify server sync is DISABLED and cached epoch is NOT zero (remains null)
      expect(coordinator.isServerSyncEnabled, isFalse);
      expect(mockRepo.getCachedServerEpoch('story-offline'), isNull);

      // 2. User reads offline and updates progress
      coordinator.recordProgress(
        storyId: 'story-offline',
        chapterId: 'ch-offline-1',
        flutterPageIndex: 2,
        progressPercentage: 25.0,
        scrollPosition: 600.0,
      );

      // Local checkpoint is saved
      verify(() => mockRepo.saveLocalCheckpoint(any())).called(1);

      // Network must NOT be touched and must NOT send writeEpoch: 0
      await coordinator.flush();
      verifyNever(() => mockRepo.saveProgress(any()));

      // 3. Network recovers, re-hydration yields canonical epoch (e.g. 7)
      when(() => mockRepo.ensureServerEpoch('story-offline')).thenAnswer((_) async => 7);
      when(() => mockRepo.getCachedServerEpoch('story-offline')).thenReturn(7);
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 'story-offline', writeEpoch: 7),
      );

      // Start new session after reconnection
      await coordinator.startSession('story-offline');
      expect(coordinator.isServerSyncEnabled, isTrue);

      // Pending draft is now materialized with canonical epoch 7
      await Future<void>.delayed(const Duration(milliseconds: 250));
      verify(() => mockRepo.saveProgress(any(
            that: isA<ReadingProgressPayload>().having((p) => p.writeEpoch, 'writeEpoch', 7),
          ))).called(1);
    });
  });
}
