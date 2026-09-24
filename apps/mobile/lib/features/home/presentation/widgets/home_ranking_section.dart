import 'package:flutter/material.dart';
import '../../../../app/theme/app_colors.dart';
import '../../../../core/theme/theme_tokens.dart';
import '../../../story/models/story_models.dart';

class HomeRankingSection extends StatefulWidget {
  final StoryRankingsResponse rankings;
  final ValueChanged<StorySummary> onStoryTap;

  const HomeRankingSection({
    super.key,
    required this.rankings,
    required this.onStoryTap,
  });

  @override
  State<HomeRankingSection> createState() => _HomeRankingSectionState();
}

class _HomeRankingSectionState extends State<HomeRankingSection>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final topComics = widget.rankings.topComics;
    final topNovels = widget.rankings.topNovels;

    if (topComics.isEmpty && topNovels.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 12,
          runSpacing: 10,
          children: [
            const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.emoji_events, color: Colors.amber, size: 22),
                SizedBox(width: 8),
                Text(
                  'Bảng Xếp Hạng',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    color: AppColors.textPrimary,
                  ),
                ),
              ],
            ),
            Container(
              height: 32,
              decoration: BoxDecoration(
                color: AppColors.darkSurface,
                borderRadius: BorderRadius.circular(16),
              ),
              child: TabBar(
                controller: _tabController,
                isScrollable: true,
                tabAlignment: TabAlignment.start,
                dividerColor: Colors.transparent,
                indicatorSize: TabBarIndicatorSize.tab,
                indicator: BoxDecoration(
                  color: context.primaryColor,
                  borderRadius: BorderRadius.circular(16),
                ),
                labelColor: Colors.white,
                unselectedLabelColor: AppColors.textMuted,
                labelStyle: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                ),
                tabs: const [
                  Tab(text: 'Truyện Tranh'),
                  Tab(text: 'Tiểu Thuyết'),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        SizedBox(
          height: 320,
          child: TabBarView(
            controller: _tabController,
            children: [
              _buildRankingList(topComics),
              _buildRankingList(topNovels),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildRankingList(List<StorySummary> stories) {
    if (stories.isEmpty) {
      return Container(
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AppColors.darkSurface,
          borderRadius: BorderRadius.circular(12),
        ),
        child: const Text(
          'Chưa có dữ liệu bảng xếp hạng.',
          style: TextStyle(color: AppColors.textMuted),
        ),
      );
    }

    return ListView.separated(
      physics: const BouncingScrollPhysics(),
      itemCount: stories.length.clamp(0, 5),
      separatorBuilder: (_, __) => const Divider(
        color: AppColors.darkBorder,
        height: 1,
        indent: 48,
      ),
      itemBuilder: (context, index) {
        final story = stories[index];
        final rank = index + 1;

        Color rankColor = AppColors.textMuted;
        if (rank == 1) rankColor = Colors.amber;
        if (rank == 2) rankColor = const Color(0xFFC0C0C0);
        if (rank == 3) rankColor = const Color(0xFFCD7F32);

        return InkWell(
          onTap: () => widget.onStoryTap(story),
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
            child: Row(
              children: [
                // Rank number
                SizedBox(
                  width: 32,
                  child: Text(
                    '$rank',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: rankColor,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                // Cover thumbnail
                ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: Container(
                    width: 44,
                    height: 58,
                    color: AppColors.darkSurfaceElevated,
                    child: story.coverUrl != null && story.coverUrl!.isNotEmpty
                        ? Image.network(
                            story.coverUrl!,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => Icon(
                              Icons.auto_stories,
                              color: context.primaryColor,
                              size: 20,
                            ),
                          )
                        : Icon(
                            Icons.auto_stories,
                            color: context.primaryColor,
                            size: 20,
                          ),
                  ),
                ),
                const SizedBox(width: 12),
                // Info
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
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          const Icon(Icons.remove_red_eye_outlined,
                              size: 13, color: AppColors.textMuted),
                          const SizedBox(width: 4),
                          Text(
                            _formatNumber(story.viewsCount),
                            style: const TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 12,
                            ),
                          ),
                          if (story.publicationFormat != null) ...[
                            const SizedBox(width: 8),
                            Text(
                              '• ${story.publicationFormat}',
                              style: const TextStyle(
                                color: AppColors.textMuted,
                                fontSize: 11,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                ),
                const Icon(
                  Icons.chevron_right,
                  color: AppColors.textMuted,
                  size: 20,
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  String _formatNumber(int number) {
    if (number >= 1000000) {
      return '${(number / 1000000).toStringAsFixed(1)}M';
    } else if (number >= 1000) {
      return '${(number / 1000).toStringAsFixed(1)}K';
    }
    return number.toString();
  }
}
