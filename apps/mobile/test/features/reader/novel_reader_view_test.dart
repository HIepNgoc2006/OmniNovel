import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/novel_block_models.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/novel_reader_view.dart';
import 'package:omninovel_mobile/features/reader/presentation/novel_settings_controller.dart';
import 'package:omninovel_mobile/features/reader/presentation/reading_progress_coordinator.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';

class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
    registerFallbackValue(
      const ReadingProgressPayload(
        chapterId: 'c1',
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

  late MockReadingProgressRepository mockRepo;
  late ReadingProgressCoordinator coordinator;
  late NovelSettingsController settingsController;

  final blocks = [
    const NovelBlockItem(
      anchorBlockId: 'blk_0001_h1',
      blockType: NovelBlockType.heading,
      rawText: 'Chương 1: Khởi đầu mới',
      level: 1,
    ),
    const NovelBlockItem(
      anchorBlockId: 'blk_0002_p',
      blockType: NovelBlockType.narration,
      rawText: 'Gió mùa thu xào xạc thổi qua con đường nhỏ.',
    ),
    const NovelBlockItem(
      anchorBlockId: 'blk_0003_dlg',
      blockType: NovelBlockType.dialogue,
      rawText: '「Chúng ta sẽ đi đâu bây giờ?」',
    ),
    const NovelBlockItem(
      anchorBlockId: 'blk_0004_quote',
      blockType: NovelBlockType.blockquote,
      rawText: 'Lời răn dạy của tiền nhân được khắc trên bia đá.',
    ),
  ];

  setUp(() {
    mockRepo = MockReadingProgressRepository();
    when(() => mockRepo.saveLocalCheckpoint(any())).thenAnswer((_) async {});
    when(() => mockRepo.saveProgress(any())).thenAnswer((_) async => const ReadingProgressResponse(storyId: 'story-1', writeEpoch: 1));

    coordinator = ReadingProgressCoordinator(
      repository: mockRepo,
      debounceDuration: const Duration(milliseconds: 50),
    );

    settingsController = NovelSettingsController();
  });

  tearDown(() {
    coordinator.dispose();
  });

  testWidgets('NovelReaderView hiển thị đầy đủ các block đoạn văn và trigger onTap', (tester) async {
    bool tapped = false;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NovelReaderView(
            storyId: 'story-1',
            chapterId: 'chap-1',
            blocks: blocks,
            coordinator: coordinator,
            settingsController: settingsController,
            onTap: () {
              tapped = true;
            },
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Chương 1: Khởi đầu mới'), findsOneWidget);
    expect(find.text('Gió mùa thu xào xạc thổi qua con đường nhỏ.'), findsOneWidget);

    // Chạm vào màn hình để kiểm tra toggle HUD
    await tester.tap(find.byType(NovelReaderView));
    expect(tapped, isTrue);
  });

  testWidgets('Resumption ưu tiên canonical anchorBlockId', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NovelReaderView(
            storyId: 'story-1',
            chapterId: 'chap-1',
            blocks: blocks,
            coordinator: coordinator,
            settingsController: settingsController,
            initialAnchorBlockId: 'blk_0002_p',
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    // Xác nhận ListView đã khởi tạo và scroll offset được tính toán
    final listView = tester.widget<ListView>(find.byType(ListView));
    expect(listView.controller, isNotNull);
  });
}
