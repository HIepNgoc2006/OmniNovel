import 'dart:async';
import 'package:flutter/material.dart';
import '../../../../app/theme/app_colors.dart';
import '../../../../core/theme/theme_tokens.dart';
import '../../../story/models/story_models.dart';

class HomeCarouselBanner extends StatefulWidget {
  final List<StorySummary> banners;
  final ValueChanged<StorySummary> onStoryTap;

  const HomeCarouselBanner({
    super.key,
    required this.banners,
    required this.onStoryTap,
  });

  @override
  State<HomeCarouselBanner> createState() => _HomeCarouselBannerState();
}

class _HomeCarouselBannerState extends State<HomeCarouselBanner> {
  late final PageController _pageController;
  int _currentPage = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _pageController = PageController();
    _startTimer();
  }

  void _startTimer() {
    if (widget.banners.length <= 1) return;
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!mounted || !_pageController.hasClients) return;
      final nextPage = (_currentPage + 1) % widget.banners.length;
      _pageController.animateToPage(
        nextPage,
        duration: const Duration(milliseconds: 600),
        curve: Curves.easeInOutCubic,
      );
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.banners.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      children: [
        SizedBox(
          height: 200,
          child: PageView.builder(
            controller: _pageController,
            onPageChanged: (idx) {
              setState(() {
                _currentPage = idx;
              });
            },
            itemCount: widget.banners.length,
            itemBuilder: (context, index) {
              final story = widget.banners[index];
              final formatLabel = story.publicationFormat ?? story.mediaFormat;

              return GestureDetector(
                onTap: () => widget.onStoryTap(story),
                child: Container(
                  margin: const EdgeInsets.symmetric(horizontal: 4.0),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(16),
                    color: AppColors.darkSurfaceElevated,
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.35),
                        blurRadius: 10,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  clipBehavior: Clip.antiAlias,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      // Backdrop / Cover
                      if (story.bannerUrl != null && story.bannerUrl!.isNotEmpty)
                        Image.network(
                          story.bannerUrl!,
                          fit: BoxFit.cover,
                          errorBuilder: (ctx, __, ___) => _buildPlaceholder(story),
                        )
                      else if (story.coverUrl != null && story.coverUrl!.isNotEmpty)
                        Image.network(
                          story.coverUrl!,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => _buildPlaceholder(story),
                        )
                      else
                        _buildPlaceholder(story),

                      // Gradient Overlay for Readability
                      Container(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              Colors.transparent,
                              AppColors.oledBlack.withValues(alpha: 0.3),
                              AppColors.oledBlack.withValues(alpha: 0.95),
                            ],
                            stops: const [0.3, 0.65, 1.0],
                          ),
                        ),
                      ),

                      // Title & Badges
                      Positioned(
                        left: 16,
                        right: 16,
                        bottom: 14,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Row(
                              children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 8,
                                    vertical: 3,
                                  ),
                                  decoration: BoxDecoration(
                                    color: context.primaryColor,
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: Text(
                                    formatLabel.toUpperCase(),
                                    style: const TextStyle(
                                      color: Colors.white,
                                      fontSize: 10,
                                      fontWeight: FontWeight.bold,
                                      letterSpacing: 0.5,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                if (story.status == 'COMPLETED')
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 6,
                                      vertical: 2,
                                    ),
                                    decoration: BoxDecoration(
                                      color: Colors.green.withValues(alpha: 0.3),
                                      borderRadius: BorderRadius.circular(4),
                                      border: Border.all(
                                        color: Colors.greenAccent,
                                        width: 0.8,
                                      ),
                                    ),
                                    child: const Text(
                                      'FULL',
                                      style: TextStyle(
                                        color: Colors.greenAccent,
                                        fontSize: 9,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Text(
                              story.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: AppColors.textPrimary,
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                                shadows: [
                                  Shadow(
                                    color: Colors.black,
                                    blurRadius: 4,
                                    offset: Offset(0, 1),
                                  ),
                                ],
                              ),
                            ),
                            if (story.summary != null && story.summary!.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Text(
                                story.summary!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  color: AppColors.textSecondary,
                                  fontSize: 12,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
        if (widget.banners.length > 1) ...[
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(widget.banners.length, (index) {
              final isSelected = index == _currentPage;
              return AnimatedContainer(
                duration: const Duration(milliseconds: 300),
                margin: const EdgeInsets.symmetric(horizontal: 3),
                width: isSelected ? 18 : 6,
                height: 6,
                decoration: BoxDecoration(
                  color: isSelected ? context.primaryColor : AppColors.darkBorder,
                  borderRadius: BorderRadius.circular(3),
                ),
              );
            }),
          ),
        ],
      ],
    );
  }

  Widget _buildPlaceholder(StorySummary story) {
    return Container(
      color: AppColors.darkSurface,
      alignment: Alignment.center,
      child: Icon(
        Icons.auto_stories,
        color: context.primaryLightColor,
        size: 56,
      ),
    );
  }
}
