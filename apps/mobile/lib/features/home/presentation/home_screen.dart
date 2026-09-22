import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/auth/auth_service.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../app/theme/app_colors.dart';
import '../../story/models/story_models.dart';
import '../../story/repositories/story_repository.dart';

class HomeScreen extends StatefulWidget {
  final AuthService authService;
  final ApiClient apiClient;
  final StoryRepository? storyRepository;

  const HomeScreen({
    super.key,
    required this.authService,
    required this.apiClient,
    this.storyRepository,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final StoryRepository _storyRepository;
  FeaturedStoriesResponse? _featured;
  bool _isLoadingFeatured = true;

  String? _authenticatedDataStatus;
  bool _isLoadingData = false;

  @override
  void initState() {
    super.initState();
    _storyRepository = widget.storyRepository ??
        StoryRepository(apiClient: widget.apiClient);
    _loadFeaturedStories();
  }

  Future<void> _loadFeaturedStories() async {
    setState(() {
      _isLoadingFeatured = true;
    });

    try {
      final res = await _storyRepository.getFeaturedStories();
      if (mounted) {
        setState(() {
          _featured = res;
          _isLoadingFeatured = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _isLoadingFeatured = false;
        });
      }
    }
  }

  Future<void> _fetchMe() async {
    setState(() {
      _isLoadingData = true;
      _authenticatedDataStatus = null;
    });

    try {
      final response =
          await widget.apiClient.get<Map<String, dynamic>>(ApiEndpoints.me);
      if (mounted) {
        setState(() {
          _authenticatedDataStatus =
              'Xác thực thành công! ID: ${response.data?['id']}, Role: ${response.data?['role']}';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _authenticatedDataStatus = 'Lỗi truy xuất: $e';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _isLoadingData = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.authService.state.user;

    return Scaffold(
      appBar: AppBar(
        title: const Text('OmniNovel Mobile'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Đăng xuất',
            onPressed: () async {
              await widget.authService.logout();
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _loadFeaturedStories,
        color: AppColors.primary,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // User Header Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 24,
                      backgroundColor: AppColors.primary.withValues(alpha: 0.2),
                      child: Text(
                        user?.username.isNotEmpty == true
                            ? user!.username[0].toUpperCase()
                            : 'U',
                        style: const TextStyle(
                          color: AppColors.primary,
                          fontWeight: FontWeight.bold,
                          fontSize: 20,
                        ),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            user?.username ?? 'Độc giả OmniNovel',
                            style: const TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                              color: AppColors.textPrimary,
                            ),
                          ),
                          Text(
                            user?.email ?? '',
                            style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),

            // Mục Truyện Đề Cử / Nổi Bật
            const Text(
              'Truyện Nổi Bật',
              style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.bold,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 12),

            if (_isLoadingFeatured)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(24.0),
                  child: CircularProgressIndicator(color: AppColors.primary),
                ),
              )
            else if (_featured == null || _featured!.hotStories.isEmpty)
              Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  color: AppColors.darkSurface,
                  borderRadius: BorderRadius.circular(12),
                ),
                alignment: Alignment.center,
                child: const Text(
                  'Chưa có truyện nào trong danh sách đề cử.',
                  style: TextStyle(color: AppColors.textMuted),
                ),
              )
            else
              ListView.separated(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: _featured!.hotStories.length,
                separatorBuilder: (_, __) => const SizedBox(height: 12),
                itemBuilder: (context, index) {
                  final story = _featured!.hotStories[index];
                  return Card(
                    clipBehavior: Clip.antiAlias,
                    child: ListTile(
                      contentPadding: const EdgeInsets.all(12),
                      leading: Container(
                        width: 48,
                        height: 64,
                        decoration: BoxDecoration(
                          color: AppColors.darkSurfaceElevated,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        alignment: Alignment.center,
                        child: const Icon(Icons.auto_stories,
                            color: AppColors.primary),
                      ),
                      title: Text(
                        story.title,
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      subtitle: Text(
                        story.summary ?? '${story.viewsCount} lượt xem',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 13,
                        ),
                      ),
                      trailing: const Icon(Icons.chevron_right,
                          color: AppColors.textMuted),
                      onTap: () {
                        context.push('/story/${story.slug}');
                      },
                    ),
                  );
                },
              ),

            const SizedBox(height: 32),

            // Nút kiểm thử xác thực API Core (Foundation test guarantee)
            ElevatedButton.icon(
              onPressed: _isLoadingData ? null : _fetchMe,
              icon: _isLoadingData
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Icon(Icons.security),
              label: const Text('Kiểm tra xác thực Token (GET /auth/me)'),
            ),

            if (_authenticatedDataStatus != null) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.darkSurfaceElevated,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.darkBorder),
                ),
                child: Text(
                  _authenticatedDataStatus!,
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 13,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
