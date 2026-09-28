import 'package:flutter/material.dart';
import '../models/studio_models.dart';
import '../repositories/studio_repository.dart';
import 'controllers/studio_approval_controller.dart';
import 'widgets/manga_preview_comparison_view.dart';
import 'widgets/novel_segment_comparison_view.dart';
import 'widgets/studio_apply_form_view.dart';

class StudioQuickApprovalSheet extends StatefulWidget {
  final StudioRepository repository;
  final String jobId;
  final VoidCallback? onAppliedSuccessfully;

  const StudioQuickApprovalSheet({
    super.key,
    required this.repository,
    required this.jobId,
    this.onAppliedSuccessfully,
  });

  static Future<void> show(
    BuildContext context, {
    required StudioRepository repository,
    required String jobId,
    VoidCallback? onAppliedSuccessfully,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) {
        return StudioQuickApprovalSheet(
          repository: repository,
          jobId: jobId,
          onAppliedSuccessfully: onAppliedSuccessfully,
        );
      },
    );
  }

  @override
  State<StudioQuickApprovalSheet> createState() => _StudioQuickApprovalSheetState();
}

class _StudioQuickApprovalSheetState extends State<StudioQuickApprovalSheet>
    with SingleTickerProviderStateMixin {
  late Future<TranslationJobReviewDetailResponse> _detailFuture;
  StudioApprovalController? _controller;
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadJobDetail();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _controller?.dispose();
    super.dispose();
  }

  void _loadJobDetail() {
    _detailFuture = widget.repository.getJobDetail(widget.jobId).then((detail) {
      final ctrl = StudioApprovalController(
        repository: widget.repository,
        initialJobDetail: detail,
      );
      _controller = ctrl;
      return detail;
    });
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return DraggableScrollableSheet(
      initialChildSize: 0.88,
      minChildSize: 0.5,
      maxChildSize: 0.96,
      builder: (context, scrollController) {
        return Container(
          decoration: BoxDecoration(
            color: colorScheme.surface,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.25),
                blurRadius: 16,
                offset: const Offset(0, -4),
              ),
            ],
          ),
          child: FutureBuilder<TranslationJobReviewDetailResponse>(
            future: _detailFuture,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      CircularProgressIndicator(),
                      SizedBox(height: 16),
                      Text('Đang tải thông tin bản dịch...'),
                    ],
                  ),
                );
              }

              if (snapshot.hasError) {
                return Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.error_outline, size: 48, color: colorScheme.error),
                        const SizedBox(height: 12),
                        Text(
                          'Không thể tải thông tin bản dịch:\n${snapshot.error}',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: colorScheme.error),
                        ),
                        const SizedBox(height: 16),
                        ElevatedButton.icon(
                          onPressed: () => setState(_loadJobDetail),
                          icon: const Icon(Icons.refresh),
                          label: const Text('Thử lại'),
                        ),
                      ],
                    ),
                  ),
                );
              }

              final detail = snapshot.data!;
              final ctrl = _controller!;

              return ListenableBuilder(
                listenable: ctrl,
                builder: (context, _) {
                  final isComic = detail.context.story.mediaFormat == MediaFormat.comic;
                  final chapterNum = detail.context.chapter.chapterNumber;

                  return Column(
                    children: [
                      // Header & drag handle
                      Container(
                        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                        child: Column(
                          children: [
                            Container(
                              width: 44,
                              height: 4,
                              decoration: BoxDecoration(
                                color: colorScheme.outlineVariant,
                                borderRadius: BorderRadius.circular(2),
                              ),
                            ),
                            const SizedBox(height: 12),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Row(
                                  children: [
                                    Icon(
                                      isComic ? Icons.menu_book : Icons.auto_stories,
                                      size: 20,
                                      color: colorScheme.primary,
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      'Duyệt bản dịch AI — Chương $chapterNum',
                                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                            fontWeight: FontWeight.bold,
                                          ),
                                    ),
                                  ],
                                ),
                                IconButton(
                                  onPressed: () => Navigator.of(context).pop(),
                                  icon: const Icon(Icons.close),
                                  tooltip: 'Đóng',
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),

                      // TabBar: So sánh & Phê duyệt
                      TabBar(
                        controller: _tabController,
                        tabs: const [
                          Tab(
                            icon: Icon(Icons.compare, size: 18),
                            text: 'So sánh kết quả',
                          ),
                          Tab(
                            icon: Icon(Icons.check_circle_outline, size: 18),
                            text: 'Phê duyệt',
                          ),
                        ],
                      ),

                      // Tab Views
                      Expanded(
                        child: TabBarView(
                          controller: _tabController,
                          children: [
                            // Tab 1: So sánh kết quả
                            isComic
                                ? MangaPreviewComparisonView(
                                    repository: widget.repository,
                                    jobId: widget.jobId,
                                    initialPageCount: detail.reviewSummary.pageCount,
                                  )
                                : NovelSegmentComparisonView(
                                    repository: widget.repository,
                                    jobId: widget.jobId,
                                  ),

                            // Tab 2: Phê duyệt
                            StudioApplyFormView(
                              controller: ctrl,
                              onApplySuccess: () {
                                widget.onAppliedSuccessfully?.call();
                              },
                            ),
                          ],
                        ),
                      ),
                    ],
                  );
                },
              );
            },
          ),
        );
      },
    );
  }
}
