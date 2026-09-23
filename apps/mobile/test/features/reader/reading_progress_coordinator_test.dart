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
        chapterId: 'c1',
        progressPercentage: 0,
        scrollPosition: 0,
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
    coordinator = ReadingProgressCoordinator(
      repository: mockRepo,
      debounceDuration: const Duration(milliseconds: 200),
    );
  });

  tearDown(() {
    coordinator.dispose();
  });

  group('ReadingProgressCoordinator Tests', () {
    test('recordProgress immediately writes to local checkpoint', () async {
      when(() => mockRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => {});
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1'),
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

    test('recordProgress debounces server sync', () async {
      when(() => mockRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => {});
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1'),
      );

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
                .having((p) => p.progressPercentage, 'progressPercentage', 30.0),
          ))).called(1);
    });

    test('flush cancels timer and immediately pushes to server', () async {
      when(() => mockRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => {});
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1'),
      );

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
      when(() => mockRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => {});
      when(() => mockRepo.saveProgress(any())).thenAnswer(
        (_) async => const ReadingProgressResponse(storyId: 's1'),
      );

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
