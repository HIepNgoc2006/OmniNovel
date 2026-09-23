import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart';
import 'package:omninovel_mobile/features/story/presentation/story_detail_screen.dart';
import 'package:omninovel_mobile/features/story/repositories/story_repository.dart';

class MockStoryRepository extends Mock implements StoryRepository {}
class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}

void main() {
  late MockStoryRepository mockStoryRepo;
  late MockReadingProgressRepository mockProgressRepo;

  setUp(() {
    mockStoryRepo = MockStoryRepository();
    mockProgressRepo = MockReadingProgressRepository();

    when(() => mockProgressRepo.getLocalCheckpoint(any())).thenAnswer((_) async => null);
    when(() => mockProgressRepo.getProgress(any())).thenAnswer(
      (_) async => const ReadingProgressResponse(
        storyId: 'story-1',
        chapterId: 'ch-1',
        readChapterIds: ['ch-1', 'ch-2'],
      ),
    );
  });

  Widget buildWidget(StoryDetail story) {
    when(() => mockStoryRepo.getStoryBySlug(story.slug)).thenAnswer((_) async => story);

    return MaterialApp(
      home: StoryDetailScreen(
        slug: story.slug,
        storyRepository: mockStoryRepo,
        readingProgressRepository: mockProgressRepo,
      ),
    );
  }

  testWidgets('StoryDetailScreen sorts chapters numerically (1, 2, 9.5, 10, 10.5) avoiding string sort traps', (tester) async {
    const story = StoryDetail(
      id: 'story-1',
      slug: 'test-story',
      title: 'Truyện Thử Nghiệm Số Chương',
      editions: [
        StoryEdition(
          id: 'ed-1',
          editionName: 'Default',
          isDefault: true,
          chapters: [
            ChapterItemSummary(id: 'ch-10', chapterNumber: '10', title: 'Mười'),
            ChapterItemSummary(id: 'ch-1', chapterNumber: '1', title: 'Một'),
            ChapterItemSummary(id: 'ch-10.5', chapterNumber: '10.5', title: 'Mười rưỡi'),
            ChapterItemSummary(id: 'ch-2', chapterNumber: '2', title: 'Hai'),
            ChapterItemSummary(id: 'ch-9.5', chapterNumber: '9.5', title: 'Chín rưỡi'),
          ],
        ),
      ],
    );

    await tester.pumpWidget(buildWidget(story));
    await tester.pumpAndSettle();

    // Default: Sắp xếp cũ nhất (1 -> 2 -> 9.5 -> 10 -> 10.5)
    final chapterOne = find.text('Chương 1: Một');
    final chapterTwo = find.text('Chương 2: Hai');
    final chapterNineHalf = find.text('Chương 9.5: Chín rưỡi');
    final chapterTen = find.text('Chương 10: Mười');
    final chapterTenHalf = find.text('Chương 10.5: Mười rưỡi');

    expect(chapterOne, findsOneWidget);
    expect(chapterTwo, findsOneWidget);
    expect(chapterNineHalf, findsOneWidget);
    expect(chapterTen, findsOneWidget);
    expect(chapterTenHalf, findsOneWidget);

    // Verify visual order top to bottom: 1 before 2, 2 before 9.5, 9.5 before 10, 10 before 10.5
    final pos1 = tester.getTopLeft(chapterOne).dy;
    final pos2 = tester.getTopLeft(chapterTwo).dy;
    final pos95 = tester.getTopLeft(chapterNineHalf).dy;
    final pos10 = tester.getTopLeft(chapterTen).dy;
    final pos105 = tester.getTopLeft(chapterTenHalf).dy;

    expect(pos1 < pos2, isTrue, reason: 'Chương 1 phải trước Chương 2');
    expect(pos2 < pos95, isTrue, reason: 'Chương 2 phải trước Chương 9.5');
    expect(pos95 < pos10, isTrue, reason: 'Chương 9.5 phải trước Chương 10');
    expect(pos10 < pos105, isTrue, reason: 'Chương 10 phải trước Chương 10.5');

    // Click nút đảo chiều sắp xếp (Mới nhất)
    await tester.tap(find.text('Cũ nhất'));
    await tester.pumpAndSettle();

    expect(find.text('Mới nhất'), findsOneWidget);

    // Verify reversed order
    final revPos105 = tester.getTopLeft(find.text('Chương 10.5: Mười rưỡi')).dy;
    final revPos1 = tester.getTopLeft(find.text('Chương 1: Một')).dy;
    expect(revPos105 < revPos1, isTrue, reason: 'Chương 10.5 phải trước Chương 1 khi sắp xếp Mới nhất');
  });

  testWidgets('StoryDetailScreen displays volume grouping when volumes exist', (tester) async {
    const story = StoryDetail(
      id: 'story-vol',
      slug: 'story-vol',
      title: 'Truyện Có Tập',
      editions: [
        StoryEdition(
          id: 'ed-vol',
          editionName: 'Official',
          isDefault: true,
          volumes: [
            VolumeSummary(id: 'vol-1', volumeNumber: 1, title: 'Khởi đầu'),
          ],
          chapters: [
            ChapterItemSummary(id: 'ch-1', volumeId: 'vol-1', chapterNumber: '1', title: 'Tập 1 Ch 1'),
            ChapterItemSummary(id: 'ch-extra', chapterNumber: '99', title: 'Chương Ngoại Truyện'),
          ],
        ),
      ],
    );

    await tester.pumpWidget(buildWidget(story));
    await tester.pumpAndSettle();

    expect(find.text('Tập 1: Khởi đầu'), findsOneWidget);
    expect(find.text('Chương khác'), findsOneWidget);
    expect(find.text('Chương 1: Tập 1 Ch 1'), findsOneWidget);
    expect(find.text('Chương 99: Chương Ngoại Truyện'), findsOneWidget);
  });

  testWidgets('StoryDetailScreen sorts volumes by volumeNumber regardless of backend list order', (tester) async {
    const story = StoryDetail(
      id: 'story-vols-unordered',
      slug: 'story-vols-unordered',
      title: 'Truyện Tập Lộn Xộn',
      editions: [
        StoryEdition(
          id: 'ed-vol-unordered',
          editionName: 'Official',
          isDefault: true,
          volumes: [
            VolumeSummary(id: 'vol-2', volumeNumber: 2, title: 'Tập Hai'),
            VolumeSummary(id: 'vol-1', volumeNumber: 1, title: 'Tập Một'),
          ],
          chapters: [
            ChapterItemSummary(id: 'ch-2', volumeId: 'vol-2', chapterNumber: '2', title: 'Chương 2'),
            ChapterItemSummary(id: 'ch-1', volumeId: 'vol-1', chapterNumber: '1', title: 'Chương 1'),
          ],
        ),
      ],
    );

    await tester.pumpWidget(buildWidget(story));
    await tester.pumpAndSettle();

    final vol1Finder = find.text('Tập 1: Tập Một');
    final vol2Finder = find.text('Tập 2: Tập Hai');

    expect(vol1Finder, findsOneWidget);
    expect(vol2Finder, findsOneWidget);

    final posVol1 = tester.getTopLeft(vol1Finder).dy;
    final posVol2 = tester.getTopLeft(vol2Finder).dy;
    expect(posVol1 < posVol2, isTrue, reason: 'Tập 1 phải hiển thị trước Tập 2 khi đang sắp xếp Cũ nhất');
  });
}

