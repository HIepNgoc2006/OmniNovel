import 'package:flutter/widgets.dart';
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
    mockRepo = MockReadingProgressRepository();
    when(() => mockRepo.ensureServerEpoch(any())).thenAnswer((_) async => 0);
    when(() => mockRepo.getCachedServerEpoch(any())).thenReturn(0);
    when(() => mockRepo.getLocalGeneration(any())).thenReturn(0);
    when(() => mockRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => {});
    coordinator = ReadingProgressCoordinator(
      repository: mockRepo,
      debounceDuration: const Duration(milliseconds: 200),
    );
  });

  tearDown(() {
    coordinator.dispose();
  });

  group('ReadingProgressCoordinator Tests', () {
    test('recordProgress immediately writes to local checkpoint even before epoch hydration', () async {
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1', writeEpoch: 0),
      );

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 4,
        progressPercentage: 50.0,
        scrollPosition: 2000.0,
      );

      verify(() => mockRepo.saveLocalCheckpoint(any(
            that: isA<LocalReadingCheckpoint>()
                .having((c) => c.storyId, 'storyId', 's1')
                .having((c) => c.pageIndex, 'pageIndex', 5) // 1-based
                .having((c) => c.flutterPageIndex, 'flutterPageIndex', 4),
          ))).called(1);
    });

    test('recordProgress debounces server sync after session started', () async {
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1', writeEpoch: 0),
      );

      await coordinator.startSession('s1');

      // Cuộn liên tục 3 lần trong khoảng thời gian ngắn
      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 1,
        progressPercentage: 10,
        scrollPosition: 500,
      );
      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 2,
        progressPercentage: 20,
        scrollPosition: 1000,
      );
      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 3,
        progressPercentage: 30,
        scrollPosition: 1500,
      );

      // Ngay lúc này server chưa nhận request nào
      verifyNever(() => mockRepo.saveProgress(any()));

      // Đợi hết debounce timer 200ms
      await Future<void>.delayed(const Duration(milliseconds: 250));

      // Chỉ gọi saveProgress ĐÚNG 1 LẦN với payload cuối cùng
      verify(() => mockRepo.saveProgress(any(
            that: isA<ReadingProgressPayload>()
                .having((p) => p.pageIndex, 'pageIndex', 4) // flutter 3 -> server 4
                .having((p) => p.progressPercentage, 'progressPercentage', 30.0)
                .having((p) => p.writeEpoch, 'writeEpoch', 0),
          ))).called(1);
    });

    test('flush cancels timer and immediately pushes to server', () async {
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1', writeEpoch: 0),
      );

      await coordinator.startSession('s1');

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 7,
        progressPercentage: 70,
        scrollPosition: 3500,
      );

      await coordinator.flush();

      verify(() => mockRepo.saveProgress(any())).called(1);
    });

    test('lifecycle state paused triggers urgent flush', () async {
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1', writeEpoch: 0),
      );

      await coordinator.startSession('s1');

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 5,
        progressPercentage: 55,
        scrollPosition: 2500,
      );

      coordinator.didChangeAppLifecycleState(AppLifecycleState.paused);

      await Future<void>.delayed(const Duration(milliseconds: 50));
      verify(() => mockRepo.saveProgress(any())).called(1);
    });

    test('Gate 6F: Pending draft created during hydration is materialized and pushed once epoch resolves', () async {
      when(() => mockRepo.ensureServerEpoch('s1')).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        when(() => mockRepo.getCachedServerEpoch('s1')).thenReturn(3);
        return 3;
      });
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1', writeEpoch: 3),
      );

      // Start session (async, not awaited immediately)
      final sessionFuture = coordinator.startSession('s1');

      // User scrolls while hydration is still in flight
      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 2,
        progressPercentage: 25,
        scrollPosition: 1200,
      );

      // Local checkpoint was recorded
      verify(() => mockRepo.saveLocalCheckpoint(any())).called(1);
      // But server sync has NOT occurred yet
      verifyNever(() => mockRepo.saveProgress(any()));

      // Await hydration completion
      await sessionFuture;
      // Wait for scheduled debounce
      await Future<void>.delayed(const Duration(milliseconds: 250));

      // Now server sync was triggered with the correct hydrated epoch 3
      verify(() => mockRepo.saveProgress(any(
            that: isA<ReadingProgressPayload>()
                .having((p) => p.writeEpoch, 'writeEpoch', 3)
                .having((p) => p.pageIndex, 'pageIndex', 3),
          ))).called(1);
    });

    test('Gate 6C & 6E: Coordinator drops pending draft and disables sync on StaleWriteEpochException', () async {
      await coordinator.startSession('s1');

      when(() => mockRepo.saveProgress(any())).thenThrow(
        const StaleWriteEpochException(storyId: 's1', writeEpoch: 0, currentEpoch: 5),
      );

      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 1,
        progressPercentage: 10,
        scrollPosition: 500,
      );

      // Trigger flush
      await coordinator.flush();

      // Sync must now be disabled
      expect(coordinator.isServerSyncEnabled, isFalse);

      // Subsequent recordProgress calls must NOT attempt network sync
      coordinator.recordProgress(
        storyId: 's1',
        chapterId: 'c1',
        flutterPageIndex: 2,
        progressPercentage: 20,
        scrollPosition: 1000,
      );
      await Future<void>.delayed(const Duration(milliseconds: 250));

      // Still only called once (the failed one), no retries
      verify(() => mockRepo.saveProgress(any())).called(1);
    });

    test('resolveResumePointer prefers newer local checkpoint (Kill-App Scenario)', () async {
      final localCheckpoint = LocalReadingCheckpoint(
        storyId: 's1',
        chapterId: 'c2', // Đang đọc ở chapter 2
        pageIndex: 12,
        progressPercentage: 65.0,
        scrollPosition: 4000.0,
        anchorBlockId: 'blk_0012_p',
        textOffset: 0,
        updatedAt: DateTime.parse('2026-09-22T08:35:00Z'), // Mới hơn
      );

      final serverProgress = ReadingProgressResponse(
        storyId: 's1',
        chapterId: 'c1', // Server chỉ mới lưu chapter 1
        pageIndex: 5,
        progressPercentage: 50.0,
        scrollPosition: 2000.0,
        anchorBlockId: 'blk_0005_p',
        textOffset: 0,
        updatedAt: DateTime.parse('2026-09-22T08:30:00Z'), // Cũ hơn
        writeEpoch: 1,
      );

      when(() => mockRepo.getLocalCheckpoint('s1'))
          .thenAnswer((_) async => localCheckpoint);
      when(() => mockRepo.getProgress('s1'))
          .thenAnswer((_) async => serverProgress);

      final pointer = await coordinator.resolveResumePointer('s1');

      expect(pointer, isNotNull);
      expect(pointer?.isFromLocal, isTrue);
      expect(pointer?.chapterId, 'c2');
      expect(pointer?.serverPageIndex, 12);
      expect(pointer?.flutterPageIndex, 11);
      expect(pointer?.progressPercentage, 65.0);
      expect(pointer?.anchorBlockId, 'blk_0012_p');
      expect(pointer?.textOffset, 0);
    });

    test('resolveResumePointer chooses server progress when server is newer', () async {
      final localCheckpoint = LocalReadingCheckpoint(
        storyId: 's1',
        chapterId: 'c1',
        pageIndex: 5,
        progressPercentage: 40.0,
        scrollPosition: 1000.0,
        anchorBlockId: 'blk_0005_p',
        textOffset: 0,
        updatedAt: DateTime.parse('2026-09-22T08:00:00Z'), // Cũ hơn
      );

      final serverProgress = ReadingProgressResponse(
        storyId: 's1',
        chapterId: 'c3',
        pageIndex: 20,
        progressPercentage: 90.0,
        scrollPosition: 8000.0,
        anchorBlockId: 'blk_0020_dlg',
        textOffset: 0,
        updatedAt: DateTime.parse('2026-09-22T08:45:00Z'), // Mới hơn (ví dụ đọc từ Web)
        writeEpoch: 2,
      );

      when(() => mockRepo.getLocalCheckpoint('s1'))
          .thenAnswer((_) async => localCheckpoint);
      when(() => mockRepo.getProgress('s1'))
          .thenAnswer((_) async => serverProgress);

      final pointer = await coordinator.resolveResumePointer('s1');

      expect(pointer, isNotNull);
      expect(pointer?.isFromLocal, isFalse);
      expect(pointer?.chapterId, 'c3');
      expect(pointer?.serverPageIndex, 20);
      expect(pointer?.flutterPageIndex, 19);
      expect(pointer?.progressPercentage, 90.0);
      expect(pointer?.anchorBlockId, 'blk_0020_dlg');
      expect(pointer?.textOffset, 0);
    });
  });
}
