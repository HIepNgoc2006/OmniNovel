import 'package:flutter/material.dart';
import '../../../../app/theme/app_colors.dart';
import '../../../../core/theme/theme_tokens.dart';
import '../../../story/models/story_models.dart';

class HomeLatestSection extends StatelessWidget {
  final List<StorySummary> stories;
  final ValueChanged<StorySummary> onStoryTap;
  final VoidCallback onSeeAllTap;

  const HomeLatestSection({
    super.key,
    required this.stories,
    required this.onStoryTap,
    required this.onSeeAllTap,
  });

  @override
  Widget build(BuildContext context) {
    if (stories.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.auto_awesome, color: context.primaryLightColor, size: 20),
                  const SizedBox(width: 8),
                  const Flexible(
                    child: Text(
                      'Mới Cập Nhật',
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            TextButton(
              onPressed: onSeeAllTap,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('Xem tất cả', style: TextStyle(color: context.primaryLightColor)),
                  Icon(Icons.chevron_right, size: 18, color: context.primaryLightColor),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        SizedBox(
          height: 220,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            physics: const BouncingScrollPhysics(),
            itemCount: stories.length,
            separatorBuilder: (_, __) => const SizedBox(width: 12),
            itemBuilder: (context, index) {
              final story = stories[index];
              final latestChapter = story.latestChapters.isNotEmpty
                  ? story.latestChapters.first
                  : null;

              return SizedBox(
                width: 120,
                child: InkWell(
                  onTap: () => onStoryTap(story),
                  borderRadius: BorderRadius.circular(10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Cover card with badging
                      Stack(
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(10),
                            child: Container(
                              width: 120,
                              height: 160,
                              color: AppColors.darkSurfaceElevated,
                              child: story.coverUrl != null && story.coverUrl!.isNotEmpty
                                  ? Image.network(
                                      story.coverUrl!,
                                      fit: BoxFit.cover,
                                      errorBuilder: (_, __, ___) => Icon(
                                        Icons.auto_stories,
                                        color: context.primaryColor,
                                        size: 32,
                                      ),
                                    )
                                  : Icon(
                                      Icons.auto_stories,
                                      color: context.primaryColor,
                                      size: 32,
                                    ),
                            ),
                          ),
                          // Format badge top-left
                          Positioned(
                            top: 6,
                            left: 6,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: AppColors.oledBlack.withValues(alpha: 0.8),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                (story.publicationFormat ?? story.mediaFormat).toUpperCase(),
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 8,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                          ),
                          // Latest chapter bottom-right
                          if (latestChapter != null)
                            Positioned(
                              bottom: 6,
                              right: 6,
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 6,
                                  vertical: 2,
                                ),
                                decoration: BoxDecoration(
                                  color: context.primaryColor.withValues(alpha: 0.9),
                                  borderRadius: BorderRadius.circular(4),
                                ),
                                child: Text(
                                  'C.${latestChapter.chapterNumber}',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 9,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      // Title
                      Text(
                        story.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          height: 1.2,
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
