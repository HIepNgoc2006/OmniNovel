import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/auth/auth_service.dart';
import '../../library/models/library_models.dart';
import '../../library/repositories/library_repository.dart';
import '../../story/models/story_models.dart';
import '../../story/repositories/story_repository.dart';
import 'widgets/home_carousel_banner.dart';
import 'widgets/home_latest_section.dart';
import 'widgets/home_ranking_section.dart';

class HomeScreen extends StatefulWidget {
  final AuthService authService;
  final StoryRepository storyRepository;
  final LibraryRepository? libraryRepository;

  const HomeScreen({
    super.key,
    required this.authService,
    required this.storyRepository,
    this.libraryRepository,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  FeaturedStoriesResponse? _featured;
  StoryRankingsResponse? _rankings;
  List<StorySummary> _latestStories = [];
  ReadingHistoryItem? _continueReading;

  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _continueReading = widget.libraryRepository?.getCachedContinueReading();
    _loadHomeData();
  }

  Future<void> _loadHomeData() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final results = await Future.wait([
        widget.storyRepository.getFeaturedStories(),
        widget.storyRepository.getRankings(),
        widget.storyRepository.getStories(
          const FindStoriesParams(sort: 'LATEST', limit: 10),
        ),
        if (widget.libraryRepository != null)
          widget.libraryRepository!.getContinueReading()
        else
          Future.value(null),
      ]);

      if (mounted) {
        setState(() {
          _featured = results[0] as FeaturedStoriesResponse;
          _rankings = results[1] as StoryRankingsResponse;
          _latestStories = (results[2] as PaginatedStoriesResponse).data;
          _continueReading = results[3] as ReadingHistoryItem?;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _errorMessage = e.toString();
          _isLoading = false;
        });
      }
    }
  }

  void _onStoryTap(StorySummary story) {
    context.push('/story/${story.slug}');
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.authService.state.user;

    return Scaffold(
      backgroundColor: AppColors.oledBlack,
      appBar: AppBar(
        backgroundColor: AppColors.oledBlack,
        elevation: 0,
        titleSpacing: 12,
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(5),
              decoration: BoxDecoration(
                color: AppColors.primary,
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(
                Icons.auto_stories,
                color: Colors.white,
                size: 18,
              ),
            ),
            const SizedBox(width: 8),
            const Flexible(
              child: Text(
                'OmniNovel',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 19,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            key: const Key('home_library_button'),
            icon: const Icon(Icons.bookmarks_outlined, color: AppColors.textPrimary, size: 24),
            tooltip: 'Tủ sách của tôi',
            onPressed: () => context.push('/library'),
          ),
          IconButton(
            key: const Key('home_search_button'),
            icon: const Icon(Icons.search, color: AppColors.textPrimary, size: 26),
            tooltip: 'Tìm kiếm truyện',
            onPressed: () => context.push('/search'),
          ),
          IconButton(
            icon: const Icon(Icons.logout, color: AppColors.textSecondary),
            tooltip: 'Đăng xuất',
            onPressed: () async => await widget.authService.logout(),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: _buildBody(user),
    );
  }

  void _openContinueReading(ReadingHistoryItem item) {
    final uri = Uri(
      path: '/reader/${item.chapter.id}',
      queryParameters: {
        'storyId': item.story.id,
        'pageIndex': '${item.resume.flutterPageIndex}',
        if (item.resume.anchorBlockId != null)
          'anchorBlockId': item.resume.anchorBlockId!,
        'scrollPosition': '${item.resume.scrollPosition}',
        'progressPercentage': '${item.resume.progressPercentage}',
      },
    );
    context.push(uri.toString());
  }

  Widget _buildBody(dynamic user) {
    if (_isLoading) {
      return _buildLoadingSkeleton();
    }

    if (_errorMessage != null && _featured == null && _rankings == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.error, size: 48),
              const SizedBox(height: 16),
              Text(
                _errorMessage!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: _loadHomeData,
                icon: const Icon(Icons.refresh),
                label: const Text('Thử lại'),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadHomeData,
      color: AppColors.primary,
      backgroundColor: AppColors.darkSurfaceElevated,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(parent: BouncingScrollPhysics()),
        padding: const EdgeInsets.symmetric(vertical: 12),
        children: [
          // 1. Search Bar Trigger
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: InkWell(
              onTap: () => context.push('/search'),
              borderRadius: BorderRadius.circular(12),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                decoration: BoxDecoration(
                  color: AppColors.darkSurface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.darkBorder),
                ),
                child: const Row(
                  children: [
                    Icon(Icons.search, color: AppColors.textMuted, size: 20),
                    SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Tìm kiếm tên truyện, thể loại, tác giả...',
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: AppColors.textMuted, fontSize: 14),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Continue Reading Hero Card (Gate 10)
          if (_continueReading != null) ...[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: _buildContinueReadingCard(_continueReading!),
            ),
            const SizedBox(height: 16),
          ],

          // 2. Hero Banner Carousel
          if (_featured != null && _featured!.banners.isNotEmpty) ...[
            HomeCarouselBanner(
              banners: _featured!.banners,
              onStoryTap: _onStoryTap,
            ),
            const SizedBox(height: 24),
          ],

          // 3. Truyện Mới Cập Nhật
          if (_latestStories.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: HomeLatestSection(
                stories: _latestStories,
                onStoryTap: _onStoryTap,
                onSeeAllTap: () => context.push('/search?sort=LATEST'),
              ),
            ),
            const SizedBox(height: 28),
          ],

          // 4. Bảng Xếp Hạng (Rankings)
          if (_rankings != null) ...[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: HomeRankingSection(
                rankings: _rankings!,
                onStoryTap: _onStoryTap,
              ),
            ),
            const SizedBox(height: 28),
          ],

          // 5. Truyện Nổi Bật (Hot Stories Grid)
          if (_featured != null && _featured!.hotStories.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Row(
                    children: [
                      Icon(Icons.whatshot, color: Colors.deepOrangeAccent, size: 22),
                      SizedBox(width: 8),
                      Text(
                        'Truyện Nổi Bật Nhất',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.bold,
                          color: AppColors.textPrimary,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  ListView.separated(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    itemCount: _featured!.hotStories.length.clamp(0, 6),
                    separatorBuilder: (_, __) => const SizedBox(height: 12),
                    itemBuilder: (context, index) {
                      final story = _featured!.hotStories[index];
                      return InkWell(
                        onTap: () => _onStoryTap(story),
                        borderRadius: BorderRadius.circular(10),
                        child: Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: AppColors.darkSurface,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: AppColors.darkBorder),
                          ),
                          child: Row(
                            children: [
                              ClipRRect(
                                borderRadius: BorderRadius.circular(6),
                                child: Container(
                                  width: 50,
                                  height: 68,
                                  color: AppColors.darkSurfaceElevated,
                                  child: story.coverUrl != null && story.coverUrl!.isNotEmpty
                                      ? Image.network(
                                          story.coverUrl!,
                                          fit: BoxFit.cover,
                                          errorBuilder: (_, __, ___) => const Icon(
                                            Icons.auto_stories,
                                            color: AppColors.primary,
                                          ),
                                        )
                                      : const Icon(
                                          Icons.auto_stories,
                                          color: AppColors.primary,
                                        ),
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      story.title,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        color: AppColors.textPrimary,
                                        fontWeight: FontWeight.bold,
                                        fontSize: 15,
                                      ),
                                    ),
                                    const SizedBox(height: 4),
                                    Text(
                                      story.summary ?? '${story.viewsCount} lượt xem',
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        color: AppColors.textSecondary,
                                        fontSize: 12,
                                      ),
                                    ),
                                    const SizedBox(height: 4),
                                    Row(
                                      children: [
                                        Container(
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 6,
                                            vertical: 1,
                                          ),
                                          decoration: BoxDecoration(
                                            color: AppColors.primary.withValues(alpha: 0.2),
                                            borderRadius: BorderRadius.circular(4),
                                          ),
                                          child: Text(
                                            (story.publicationFormat ?? story.mediaFormat).toUpperCase(),
                                            style: const TextStyle(
                                              color: AppColors.primaryLight,
                                              fontSize: 9,
                                              fontWeight: FontWeight.bold,
                                            ),
                                          ),
                                        ),
                                        const SizedBox(width: 8),
                                        Text(
                                          '${story.viewsCount} lượt xem',
                                          style: const TextStyle(
                                            color: AppColors.textMuted,
                                            fontSize: 11,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                              ),
                              const Icon(Icons.chevron_right, color: AppColors.textMuted),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 32),
          ],
        ],
      ),
    );
  }

  Widget _buildLoadingSkeleton() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          height: 48,
          decoration: BoxDecoration(
            color: AppColors.darkSurface,
            borderRadius: BorderRadius.circular(12),
          ),
        ),
        const SizedBox(height: 20),
        Container(
          height: 190,
          decoration: BoxDecoration(
            color: AppColors.darkSurface,
            borderRadius: BorderRadius.circular(16),
          ),
        ),
        const SizedBox(height: 24),
        Container(
          height: 20,
          width: 150,
          color: AppColors.darkSurface,
        ),
        const SizedBox(height: 12),
        Row(
          children: List.generate(
            3,
            (_) => Expanded(
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 4),
                height: 180,
                decoration: BoxDecoration(
                  color: AppColors.darkSurface,
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildContinueReadingCard(ReadingHistoryItem item) {
    return Container(
      key: const Key('home_continue_reading_card'),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            AppColors.primary.withValues(alpha: 0.25),
            AppColors.darkSurface,
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.4)),
      ),
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: Container(
              width: 48,
              height: 64,
              color: AppColors.darkSurfaceElevated,
              child: item.story.coverUrl != null
                  ? Image.network(
                      item.story.coverUrl!,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => const Icon(
                        Icons.auto_stories,
                        color: AppColors.primary,
                      ),
                    )
                  : const Icon(Icons.auto_stories, color: AppColors.primary),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  children: [
                    Icon(Icons.history, color: AppColors.primaryLight, size: 14),
                    SizedBox(width: 4),
                    Text(
                      'ĐỌC TIẾP',
                      style: TextStyle(
                        color: AppColors.primaryLight,
                        fontWeight: FontWeight.bold,
                        fontSize: 11,
                        letterSpacing: 1.0,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  item.story.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                  ),
                ),
                Text(
                  'Chương ${item.chapter.chapterNumber} (${item.resume.progressPercentage.toStringAsFixed(0)}%)',
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            onPressed: () => _openContinueReading(item),
            child: const Text('Tiếp', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }
}

