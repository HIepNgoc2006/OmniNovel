import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:omninovel_mobile/features/search/presentation/search_screen.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart';
import 'package:omninovel_mobile/features/story/repositories/story_repository.dart';

class MockStoryRepository extends Mock implements StoryRepository {}

void main() {
  late MockStoryRepository mockStoryRepo;

  setUpAll(() {
    registerFallbackValue(const FindStoriesParams());
  });

  setUp(() {
    mockStoryRepo = MockStoryRepository();
    SharedPreferences.setMockInitialValues({});

    when(() => mockStoryRepo.getGenres()).thenAnswer(
      (_) async => const [
        Genre(id: 1, name: 'Hành Động', slug: 'action'),
        Genre(id: 2, name: 'Tình Cảm', slug: 'romance'),
      ],
    );

    when(() => mockStoryRepo.getStories(any())).thenAnswer(
      (_) async => const PaginatedStoriesResponse(
        data: [
          StorySummary(id: 's1', slug: 'solo-leveling', title: 'Solo Leveling', viewsCount: 15000),
        ],
        pagination: PaginationMeta(page: 1, limit: 20, total: 1, totalPages: 1),
      ),
    );
  });

  Widget buildWidget() {
    return MaterialApp(
      home: SearchScreen(storyRepository: mockStoryRepo),
    );
  }

  testWidgets('SearchScreen renders search field, loads canonical genres and initial results', (tester) async {
    await tester.pumpWidget(buildWidget());
    await tester.pumpAndSettle();

    // Verify search bar and filter badges
    expect(find.byType(TextField), findsOneWidget);
    expect(find.text('Mới nhất'), findsOneWidget);
    expect(find.text('Định dạng'), findsOneWidget);
    expect(find.text('Tình trạng'), findsOneWidget);
    expect(find.text('Thể loại'), findsOneWidget);

    // Initial search performed
    expect(find.text('Solo Leveling'), findsOneWidget);
    verify(() => mockStoryRepo.getGenres()).called(1);
    verify(() => mockStoryRepo.getStories(any())).called(1);
  });

  testWidgets('SearchScreen debounces text input before calling getStories', (tester) async {
    await tester.pumpWidget(buildWidget());
    await tester.pumpAndSettle();

    clearInteractions(mockStoryRepo);

    // Type query
    await tester.enterText(find.byType(TextField), 'Omni');
    await tester.pump(const Duration(milliseconds: 200));

    // Debounce 500ms has not fired yet
    verifyNever(() => mockStoryRepo.getStories(any()));

    // Fast-forward past 500ms
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();

    // Now called with search 'Omni'
    verify(() => mockStoryRepo.getStories(any(
      that: isA<FindStoriesParams>().having((p) => p.search, 'search', 'Omni'),
    ))).called(1);
  });

  testWidgets('SearchScreen saves search query to recent searches', (tester) async {
    await tester.pumpWidget(buildWidget());
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Isekai');
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();

    // Clear text to reveal recent searches
    await tester.enterText(find.byType(TextField), '');
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();

    expect(find.text('Tìm kiếm gần đây'), findsOneWidget);
    expect(find.text('Isekai'), findsOneWidget);
  });
}
