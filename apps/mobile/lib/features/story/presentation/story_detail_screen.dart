import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/theme/theme_tokens.dart';
import '../../library/models/library_models.dart';
import '../../library/repositories/library_repository.dart';
import '../../reader/models/story_reading_state.dart';
import '../../reader/presentation/reading_progress_coordinator.dart';
import '../../reader/repositories/reading_progress_repository.dart';
import '../../reader/repositories/reading_state_access.dart';
import '../../reader/repositories/account_reading_state_adapter.dart';
import '../../offline/services/offline_content_resolver.dart';
import '../../studio/models/studio_models.dart';
import '../../studio/presentation/studio_quick_approval_sheet.dart';
import '../../studio/presentation/widgets/studio_job_chooser_dialog.dart';
import '../../studio/repositories/studio_repository.dart';
import '../../library/repositories/library_access.dart';
import '../../library/repositories/account_library_adapter.dart';
import '../../../core/identity/active_scope_coordinator.dart';
import '../models/story_models.dart';
import '../repositories/story_repository.dart';

class StoryDetailScreen extends StatefulWidget {
  final String slug;
  final StoryRepository storyRepository;
  final ReadingProgressRepository? readingProgressRepository;
  final ReadingStateAccess? readingStateAccess;
  final LibraryRepository? libraryRepository;
  final LibraryAccess? libraryAccess;
  final ActiveScopeCoordinator? scopeCoordinator;
  final StudioRepository? studioRepository;
  final OfflineContentResolver? offlineResolver;

  const StoryDetailScreen({
    super.key,
    required this.slug,
    required this.storyRepository,
    this.readingProgressRepository,
    this.readingStateAccess,
    this.libraryRepository,
    this.libraryAccess,
    this.scopeCoordinator,
    this.studioRepository,
    this.offlineResolver,
  }) : assert(
          readingStateAccess != null || readingProgressRepository != null,
          'Phải cung cấp ít nhất readingStateAccess hoặc readingProgressRepository',
        );

  @override
  State<StoryDetailScreen> createState() => _StoryDetailScreenState();
}

class _StoryDetailScreenState extends State<StoryDetailScreen> {
  StoryDetail? _story;
  ResumePointer? _resumePointer;
  Set<String> _readChapterIds = {};
  Map<String, List<TranslationJobSummaryDto>> _readyJobsByChapterId = {};
  bool _isBookmarked = false;
  int _followersCount = 0;
  bool _isTogglingBookmark = false;
  bool _isLoading = true;
  String? _errorMessage;

  bool _isAscending = true; // Sắp xếp cũ nhất -> mới nhất (chương 1 -> ...)
  bool _isSummaryExpanded = false;
  int _loadGeneration = 0;

  LibraryAccess? get _effectiveLibraryAccess =>
      widget.libraryAccess ??
      (widget.libraryRepository != null
          ? AccountLibraryAdapter(repository: widget.libraryRepository!)
          : null);

  ReadingStateAccess get _effectiveReadingStateAccess =>
      widget.readingStateAccess ??
      AccountReadingStateAdapter(
        repository: widget.readingProgressRepository!,
      );

  @override
  void initState() {
    super.initState();
    widget.scopeCoordinator?.addListener(_onScopeChanged);
    _loadStoryAndProgress();
  }

  void _onScopeChanged() {
    if (!mounted) return;
    _loadStoryAndProgress();
  }

  @override
  void dispose() {
    widget.scopeCoordinator?.removeListener(_onScopeChanged);
    super.dispose();
  }

  Future<void> _loadStoryAndProgress() async {
    final generation = ++_loadGeneration;
    final expectedScope = widget.scopeCoordinator?.activeScope;

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      // Pha 1: Phân giải slug lấy story.id
      final story = await widget.storyRepository.getStoryBySlug(widget.slug);

      // Invalidation Guard: Bỏ qua kết quả cũ nếu scope đã đổi hoặc request mới đã chạy
      if (!mounted ||
          generation != _loadGeneration ||
          widget.scopeCoordinator?.activeScope != expectedScope) {
        return;
      }

      // Pha 2: Chạy song song 1 lần duy nhất (Gate 8: Khử duplicate getProgress)
      final libraryAccess = _effectiveLibraryAccess;
      final readingStateAccess = _effectiveReadingStateAccess;

      final results = await Future.wait([
        if (libraryAccess != null)
          libraryAccess.getBookmarkStatus(story.id)
        else
          Future.value(const BookmarkStatusResponse(isBookmarked: false)),
        readingStateAccess.getStoryReadingState(story.id),
      ]);

      if (!mounted ||
          generation != _loadGeneration ||
          widget.scopeCoordinator?.activeScope != expectedScope) {
        return;
      }

      final bookmarkRes = results[0] as BookmarkStatusResponse;
      final readingState = results[1] as StoryReadingState;

      // Pha 3: Lấy danh sách Translation Jobs READY_FOR_REVIEW theo chapter nếu có studioRepository
      Map<String, List<TranslationJobSummaryDto>> readyJobs = {};
      final studioRepo = widget.studioRepository;
      if (studioRepo != null) {
        try {
          readyJobs = await studioRepo.getJobsByChapterForStory(story.id);
        } catch (_) {
          readyJobs = {};
        }
      }

      if (!mounted ||
          generation != _loadGeneration ||
          widget.scopeCoordinator?.activeScope != expectedScope) {
        return;
      }

      setState(() {
        _story = story;
        _resumePointer = readingState.resume;
        _readChapterIds = readingState.readChapterIds;
        _readyJobsByChapterId = readyJobs;
        _isBookmarked = bookmarkRes.isBookmarked;
        _followersCount = story.followersCount;
        _isLoading = false;
      });
    } catch (e) {
      if (!mounted ||
          generation != _loadGeneration ||
          widget.scopeCoordinator?.activeScope != expectedScope) {
        return;
      }
      setState(() {
        _errorMessage = e.toString();
        _isLoading = false;
      });
    }
  }

  Future<void> _openStudioQuickApproval(
    ChapterItemSummary chapter,
    List<TranslationJobSummaryDto> jobs,
  ) async {
    final studioRepo = widget.studioRepository;
    if (studioRepo == null || jobs.isEmpty) return;

    final TranslationJobSummaryDto selectedJob;
    if (jobs.length == 1) {
      selectedJob = jobs.first;
    } else {
      final chosen = await StudioJobChooserDialog.show(
        context,
        chapterNumber: chapter.chapterNumber.toString(),
        jobs: jobs,
      );
      if (chosen == null) return;
      selectedJob = chosen;
    }

    if (!mounted) return;

    await StudioQuickApprovalSheet.show(
      context,
      repository: studioRepo,
      jobId: selectedJob.id,
      onAppliedSuccessfully: () async {
        // Tải lại danh sách chương và tiến trình sau khi xuất bản thành công
        await _loadStoryAndProgress();

        // Gate 9: Version-Aware Offline Hint
        final offlineResolver = widget.offlineResolver;
        if (offlineResolver != null) {
          try {
            final resolved = await offlineResolver.resolveChapter(chapterId: chapter.id);
            if (resolved != null && mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(
                    'Đã xuất bản bản dịch mới cho Chương ${chapter.chapterNumber}. Bản tải ngoại tuyến hiện tại là phiên bản cũ.',
                  ),
                  duration: const Duration(seconds: 6),
                  action: SnackBarAction(
                    label: 'Chi tiết',
                    onPressed: () {},
                  ),
                ),
              );
            }
          } catch (_) {}
        }
      },
    );
  }

  Future<void> _toggleBookmark() async {
    if (_story == null || _isTogglingBookmark) return;
    final libraryAccess = _effectiveLibraryAccess;
    if (libraryAccess == null) return;

    _isTogglingBookmark = true;
    final prevStatus = _isBookmarked;
    final prevFollowers = _followersCount;
    final newStatus = !prevStatus;

    // Optimistic UI update (Gate 8)
    setState(() {
      _isBookmarked = newStatus;
      _followersCount =
          newStatus ? prevFollowers + 1 : (prevFollowers - 1).clamp(0, 999999);
    });

    try {
      final res = await libraryAccess.setBookmark(
        BookmarkMutation(
          storyId: _story!.id,
          isBookmarked: newStatus,
          title: _story!.title,
          slug: _story!.slug,
          coverUrl: _story!.coverUrl,
        ),
      );
      if (mounted) {
        setState(() {
          _isBookmarked = res.isBookmarked;
        });
      }
    } catch (e) {
      // Rollback khi server reject
      if (mounted) {
        setState(() {
          _isBookmarked = prevStatus;
          _followersCount = prevFollowers;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Không thể cập nhật theo dõi: ${e.toString()}'),
            backgroundColor: AppColors.error,
          ),
        );
      }
    } finally {
      _isTogglingBookmark = false;
    }
  }

  double _chapterNumberValue(String value) =>
      double.tryParse(value) ?? double.infinity;

  List<ChapterItemSummary> _sortChapters(List<ChapterItemSummary> list) {
    final sorted = List<ChapterItemSummary>.from(list);
    sorted.sort((a, b) {
      final cmp = _chapterNumberValue(a.chapterNumber)
          .compareTo(_chapterNumberValue(b.chapterNumber));
      if (cmp != 0) return _isAscending ? cmp : -cmp;
      return _isAscending ? a.id.compareTo(b.id) : b.id.compareTo(a.id);
    });
    return sorted;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.oledBlack,
      appBar: AppBar(
        title: Text(_story?.title ?? 'Chi tiết truyện'),
        backgroundColor: AppColors.oledBlack,
        elevation: 0,
        actions: [
          if (_story != null)
            IconButton(
              key: const Key('story_bookmark_button'),
              icon: Icon(
                _isBookmarked ? Icons.bookmark : Icons.bookmark_border,
                color: _isBookmarked ? context.primaryColor : AppColors.textPrimary,
              ),
              tooltip: _isBookmarked ? 'Bỏ theo dõi' : 'Theo dõi truyện',
              onPressed: _toggleBookmark,
            ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return Center(
        child: CircularProgressIndicator(color: context.primaryColor),
      );
    }

    if (_errorMessage != null || _story == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.error, size: 48),
              const SizedBox(height: 16),
              Text(
                _errorMessage ?? 'Không thể tải thông tin truyện',
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: _loadStoryAndProgress,
                child: const Text('Thử lại'),
              ),
            ],
          ),
        ),
      );
    }

    final story = _story!;
    final defaultEdition = story.editions.isNotEmpty
        ? story.editions.firstWhere((e) => e.isDefault, orElse: () => story.editions.first)
        : null;
    final allChapters = defaultEdition?.chapters ?? [];
    final volumes = List<VolumeSummary>.from(defaultEdition?.volumes ?? []);
    volumes.sort((a, b) => a.volumeNumber.compareTo(b.volumeNumber));

    return RefreshIndicator(
      onRefresh: _loadStoryAndProgress,
      color: context.primaryColor,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // 1. Header: Blurred Backdrop Cover + Cover Card + Info
          _buildBackdropHeader(story, allChapters),
          const SizedBox(height: 20),

          // 2. Tóm tắt nội dung (Expandable)
          if (story.summary != null && story.summary!.isNotEmpty) ...[
            const Text(
              'Tóm tắt',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 6),
            InkWell(
              onTap: () {
                setState(() {
                  _isSummaryExpanded = !_isSummaryExpanded;
                });
              },
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    story.summary!,
                    maxLines: _isSummaryExpanded ? null : 3,
                    overflow: _isSummaryExpanded ? TextOverflow.visible : TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 14,
                      height: 1.4,
                    ),
                  ),
                  if (story.summary!.length > 120) ...[
                    const SizedBox(height: 4),
                    Text(
                      _isSummaryExpanded ? 'Thu gọn ▲' : 'Xem thêm ▼',
                      style: TextStyle(
                        color: context.primaryLightColor,
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 20),
          ],

          // 3. Nút Đọc tiếp / Đọc từ đầu (Resume & Start Buttons)
          if (allChapters.isNotEmpty) ...[
            if (_resumePointer != null) ...[
              ElevatedButton.icon(
                key: const Key('resume_reading_button'),
                onPressed: () {
                  final targetChapter = allChapters.firstWhere(
                    (c) => c.id == _resumePointer!.chapterId,
                    orElse: () => allChapters.first,
                  );
                  final uri = Uri(
                    path: '/reader/${targetChapter.id}',
                    queryParameters: {
                      'storyId': story.id,
                      'pageIndex': '${_resumePointer!.flutterPageIndex}',
                      if (_resumePointer!.anchorBlockId != null)
                        'anchorBlockId': _resumePointer!.anchorBlockId!,
                      'scrollPosition': '${_resumePointer!.scrollPosition}',
                      'progressPercentage': '${_resumePointer!.progressPercentage}',
                    },
                  );
                  context.push(uri.toString());
                },
                icon: const Icon(Icons.play_arrow),
                label: Text(
                  story.mediaFormat == 'NOVEL'
                      ? 'Đọc tiếp'
                      : 'Đọc tiếp (Trang ${_resumePointer!.serverPageIndex})',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
              ),
              const SizedBox(height: 10),
            ],
            OutlinedButton.icon(
              key: const Key('read_from_start_button'),
              onPressed: () {
                final sorted = _sortChapters(allChapters);
                final firstChapter = sorted.isNotEmpty ? sorted.first : allChapters.first;
                context.push('/reader/${firstChapter.id}?storyId=${story.id}&pageIndex=0');
              },
              icon: const Icon(Icons.menu_book),
              label: const Text('Đọc từ đầu (Chương 1)'),
            ),
            const SizedBox(height: 24),
          ],

          // 4. Thanh tiêu đề Danh sách chương + Nút Đảo chiều sắp xếp
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Danh sách chương (${allChapters.length})',
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppColors.textPrimary,
                ),
              ),
              InkWell(
                onTap: () {
                  setState(() {
                    _isAscending = !_isAscending;
                  });
                },
                borderRadius: BorderRadius.circular(6),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Row(
                    children: [
                      Icon(
                        _isAscending ? Icons.arrow_upward : Icons.arrow_downward,
                        size: 16,
                        color: context.primaryLightColor,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        _isAscending ? 'Cũ nhất' : 'Mới nhất',
                        style: TextStyle(
                          color: context.primaryLightColor,
                          fontSize: 13,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),

          // 5. Danh sách Tập & Chương
          if (volumes.isNotEmpty)
            ..._buildVolumeGroupedList(volumes, allChapters, story)
          else
            _buildFlatChapterList(allChapters, story),
        ],
      ),
    );
  }

  Widget _buildBackdropHeader(StoryDetail story, List<ChapterItemSummary> chapters) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.darkSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.darkBorder),
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: [
          // Blurred Backdrop
          if (story.bannerUrl != null && story.bannerUrl!.isNotEmpty)
            Positioned.fill(
              child: Image.network(
                story.bannerUrl!,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink(),
              ),
            )
          else if (story.coverUrl != null && story.coverUrl!.isNotEmpty)
            Positioned.fill(
              child: Image.network(
                story.coverUrl!,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink(),
              ),
            ),
          Positioned.fill(
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 16, sigmaY: 16),
              child: Container(
                color: AppColors.oledBlack.withValues(alpha: 0.8),
              ),
            ),
          ),

          // Content info
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Container(
                    width: 100,
                    height: 140,
                    decoration: BoxDecoration(
                      color: AppColors.darkSurfaceElevated,
                      border: Border.all(color: AppColors.darkBorder),
                    ),
                    child: story.coverUrl != null && story.coverUrl!.isNotEmpty
                        ? Image.network(
                            story.coverUrl!,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => Icon(
                              Icons.auto_stories,
                              color: context.primaryColor,
                              size: 40,
                            ),
                          )
                        : Icon(
                            Icons.auto_stories,
                            color: context.primaryColor,
                            size: 40,
                          ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        story.title,
                        style: const TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.bold,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: story.genres
                            .map(
                              (g) => Container(
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                decoration: BoxDecoration(
                                  color: context.primaryColor.withValues(alpha: 0.15),
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: context.primaryColor.withValues(alpha: 0.3)),
                                ),
                                child: Text(
                                  g.name,
                                  style: TextStyle(color: context.primaryColor, fontSize: 11),
                                ),
                              ),
                            )
                            .toList(),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '${chapters.length} chương • ${story.status}',
                        style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          if (story.publicationFormat != null) ...[
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: context.primaryColor.withValues(alpha: 0.25),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                story.publicationFormat!,
                                style: TextStyle(color: context.primaryColor, fontSize: 10, fontWeight: FontWeight.bold),
                              ),
                            ),
                            const SizedBox(width: 8),
                          ],
                          Text(
                            '${story.viewsCount} lượt xem',
                            style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _buildVolumeGroupedList(
    List<VolumeSummary> volumes,
    List<ChapterItemSummary> allChapters,
    StoryDetail story,
  ) {
    final widgets = <Widget>[];

    final sortedVolumes = List<VolumeSummary>.from(volumes)
      ..sort((a, b) {
        final cmp = a.volumeNumber.compareTo(b.volumeNumber);
        return _isAscending ? cmp : -cmp;
      });

    for (final volume in sortedVolumes) {
      final volumeChapters = allChapters.where((c) => c.volumeId == volume.id).toList();
      final sortedVolumeChapters = _sortChapters(volumeChapters);

      widgets.add(
        Container(
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.darkBorder),
          ),
          clipBehavior: Clip.antiAlias,
          child: Material(
            color: AppColors.darkSurface,
            child: ExpansionTile(
              initiallyExpanded: true,
              shape: const Border(),
              collapsedShape: const Border(),
              title: Text(
                'Tập ${volume.volumeNumber}: ${volume.title}'.trim(),
                style: const TextStyle(
                  color: AppColors.textPrimary,
                  fontWeight: FontWeight.bold,
                  fontSize: 15,
                ),
              ),
              subtitle: Text(
                '${volumeChapters.length} chương',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
              children: sortedVolumeChapters
                  .map((chapter) => _buildChapterTile(chapter, story))
                  .toList(),
            ),
          ),
        ),
      );
    }

    final unassignedChapters = allChapters.where((c) => c.volumeId == null).toList();
    if (unassignedChapters.isNotEmpty) {
      final sortedUnassigned = _sortChapters(unassignedChapters);
      widgets.add(
        Container(
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.darkBorder),
          ),
          clipBehavior: Clip.antiAlias,
          child: Material(
            color: AppColors.darkSurface,
            child: ExpansionTile(
              initiallyExpanded: true,
              shape: const Border(),
              collapsedShape: const Border(),
              title: const Text(
                'Chương khác',
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontWeight: FontWeight.bold,
                  fontSize: 15,
                ),
              ),
              children: sortedUnassigned
                  .map((chapter) => _buildChapterTile(chapter, story))
                  .toList(),
            ),
          ),
        ),
      );
    }

    return widgets;
  }

  Widget _buildFlatChapterList(List<ChapterItemSummary> chapters, StoryDetail story) {
    final sorted = _sortChapters(chapters);

    return ListView.separated(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: sorted.length,
      separatorBuilder: (_, __) => const Divider(color: AppColors.darkBorder, height: 1),
      itemBuilder: (context, index) {
        return _buildChapterTile(sorted[index], story);
      },
    );
  }

  Widget _buildChapterTile(ChapterItemSummary chapter, StoryDetail story) {
    final isRead = _readChapterIds.contains(chapter.id);
    final jobsForChapter = _readyJobsByChapterId[chapter.id] ?? const [];
    final titleText = chapter.title != null && chapter.title!.isNotEmpty
        ? 'Chương ${chapter.chapterNumber}: ${chapter.title}'
        : 'Chương ${chapter.chapterNumber}';

    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      title: Row(
        children: [
          Expanded(
            child: Text(
              titleText.trim(),
              style: TextStyle(
                color: isRead ? AppColors.textMuted : AppColors.textPrimary,
                fontSize: 15,
              ),
            ),
          ),
          if (isRead) ...[
            const SizedBox(width: 8),
            const Icon(Icons.check_circle, size: 16, color: Colors.greenAccent),
          ],
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (jobsForChapter.isNotEmpty)
            InkWell(
              onTap: () => _openStudioQuickApproval(chapter, jobsForChapter),
              borderRadius: BorderRadius.circular(12),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                margin: const EdgeInsets.only(right: 6),
                decoration: BoxDecoration(
                  color: context.primaryColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: context.primaryColor.withValues(alpha: 0.6)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.auto_awesome, size: 12, color: context.primaryColor),
                    const SizedBox(width: 4),
                    Text(
                      'Duyệt AI',
                      style: TextStyle(
                        color: context.primaryColor,
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          const Icon(Icons.chevron_right, color: AppColors.textMuted),
        ],
      ),
      onTap: () {
        context.push('/reader/${chapter.id}?storyId=${story.id}&pageIndex=0');
      },
    );
  }
}
