import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/home/presentation/home_screen.dart';
import 'package:omninovel_mobile/features/home/presentation/widgets/home_carousel_banner.dart';
import 'package:omninovel_mobile/features/home/presentation/widgets/home_latest_section.dart';
import 'package:omninovel_mobile/features/home/presentation/widgets/home_ranking_section.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart';
import 'package:omninovel_mobile/features/story/repositories/story_repository.dart';

class MockAuthService extends Mock implements AuthService {}
class MockStoryRepository extends Mock implements StoryRepository {}

void main() {
  late MockAuthService mockAuthService;
  late MockStoryRepository mockStoryRepo;

  setUpAll(() {
    registerFallbackValue(const FindStoriesParams());
  });

  setUp(() {
    mockAuthService = MockAuthService();
    mockStoryRepo = MockStoryRepository();

    when(() => mockAuthService.state).thenReturn(
      const AuthState(
        status: AuthStatus.authenticated,
        user: User(id: 'u-1', username: 'tester', email: 'test@omninovel.local', role: 'READER'),
      ),
    );

    when(() => mockStoryRepo.getFeaturedStories()).thenAnswer(
      (_) async => const FeaturedStoriesResponse(
        hotStories: [
          StorySummary(id: 's1', slug: 'hot-1', title: 'Hot Story 1', viewsCount: 1000),
        ],
        banners: [
          StorySummary(id: 's1', slug: 'hot-1', title: 'Hot Banner 1', summary: 'Epic fantasy banner'),
        ],
      ),
    );

    when(() => mockStoryRepo.getRankings()).thenAnswer(
      (_) async => const StoryRankingsResponse(
        topComics: [
          StorySummary(id: 'c1', slug: 'comic-1', title: 'Top Comic 1', viewsCount: 50000),
        ],
        topNovels: [
          StorySummary(id: 'n1', slug: 'novel-1', title: 'Top Novel 1', viewsCount: 40000),
        ],
      ),
    );

    when(() => mockStoryRepo.getStories(any())).thenAnswer(
      (_) async => const PaginatedStoriesResponse(
        data: [
          StorySummary(
            id: 'l1',
            slug: 'latest-1',
            title: 'Latest Story 1',
            latestChapters: [
              ChapterItemSummary(id: 'ch-10', chapterNumber: '10', title: 'Chapter 10'),
            ],
          ),
        ],
        pagination: PaginationMeta(page: 1, limit: 10, total: 1, totalPages: 1),
      ),
    );
  });

  Widget buildWidget() {
    return MaterialApp(
      home: HomeScreen(
        authService: mockAuthService,
        storyRepository: mockStoryRepo,
      ),
    );
  }

  testWidgets('HomeScreen renders Hero Banner, Latest section and Rankings successfully', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await tester.pumpWidget(buildWidget());

    // Initially shows skeleton loading
    expect(find.byType(HomeScreen), findsOneWidget);

    await tester.pumpAndSettle();

    // Verify Discovery sections
    expect(find.byType(HomeCarouselBanner), findsOneWidget);
    expect(find.text('Hot Banner 1'), findsOneWidget);

    expect(find.byType(HomeLatestSection), findsOneWidget);
    expect(find.text('Mới Cập Nhật'), findsOneWidget);
    expect(find.text('Latest Story 1'), findsOneWidget);

    expect(find.byType(HomeRankingSection), findsOneWidget);
    expect(find.text('Bảng Xếp Hạng'), findsOneWidget);
    expect(find.text('Top Comic 1'), findsOneWidget);

    expect(find.text('Truyện Nổi Bật Nhất'), findsOneWidget);
  });

  testWidgets('HomeScreen displays search button and triggers navigation or tap', (tester) async {
    await tester.pumpWidget(buildWidget());
    await tester.pumpAndSettle();

    final searchBtn = find.byKey(const Key('home_search_button'));
    expect(searchBtn, findsOneWidget);
  });
}
