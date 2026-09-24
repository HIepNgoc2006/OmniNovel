import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/theme/theme_tokens.dart';
import '../models/library_models.dart';
import '../repositories/library_repository.dart';

class LibraryScreen extends StatefulWidget {
  final LibraryRepository libraryRepository;

  const LibraryScreen({
    super.key,
    required this.libraryRepository,
  });

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  // State Bookmarks
  List<BookmarkedStoryItem> _bookmarks = [];
  LibraryStatusFilter _selectedFilter = LibraryStatusFilter.all;
  bool _isLoadingBookmarks = true;
  String? _bookmarksError;

  // State History
  List<ReadingHistoryItem> _history = [];
  bool _isLoadingHistory = true;
  String? _historyError;

  // Continue reading card
  ReadingHistoryItem? _continueReading;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _tabController.addListener(() {
      if (mounted) setState(() {});
    });

    // 1. Stale-While-Revalidate: Nạp snapshot tức thì từ SharedPreferences
    _bookmarks = widget.libraryRepository.getCachedBookmarks();
    _history = widget.libraryRepository.getCachedHistory();
    _continueReading = widget.libraryRepository.getCachedContinueReading();

    // Nếu đã có cache thì không cần hiện màn hình loading trắng
    if (_bookmarks.isNotEmpty) _isLoadingBookmarks = false;
    if (_history.isNotEmpty) _isLoadingHistory = false;

    // 2. Kích hoạt revalidate ngầm từ backend
    _revalidateAll();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _revalidateAll() async {
    await Future.wait([
      _fetchBookmarks(),
      _fetchHistory(),
      _fetchContinueReading(),
    ]);
  }

  Future<void> _fetchContinueReading() async {
    final item = await widget.libraryRepository.getContinueReading();
    if (mounted) {
      setState(() {
        _continueReading = item;
      });
    }
  }

  Future<void> _fetchBookmarks() async {
    try {
      final res = await widget.libraryRepository.fetchBookmarks(
        page: 1,
        limit: 20,
        status: _selectedFilter.apiValue,
      );
      if (mounted) {
        setState(() {
          _bookmarks = res.data;
          _isLoadingBookmarks = false;
          _bookmarksError = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoadingBookmarks = false;
          _bookmarksError = _bookmarks.isEmpty ? e.toString() : null;
        });
      }
    }
  }

  Future<void> _fetchHistory() async {
    try {
      final res = await widget.libraryRepository.fetchHistory(page: 1, limit: 20);
      if (mounted) {
        setState(() {
          _history = res.data;
          _isLoadingHistory = false;
          _historyError = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoadingHistory = false;
          _historyError = _history.isEmpty ? e.toString() : null;
        });
      }
    }
  }

  void _onFilterChanged(LibraryStatusFilter filter) {
    setState(() {
      _selectedFilter = filter;
      _bookmarks = widget.libraryRepository.getCachedBookmarks(status: filter.apiValue);
      _isLoadingBookmarks = true;
    });
    _fetchBookmarks();
  }

  Future<void> _confirmDeleteStoryHistory(ReadingHistoryItem item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.darkSurface,
        title: const Text('Xóa lịch sử đọc', style: TextStyle(color: AppColors.textPrimary)),
        content: Text(
          'Bạn có chắc chắn muốn xóa "${item.story.title}" khỏi lịch sử đọc không?',
          style: const TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Hủy'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Xóa'),
          ),
        ],
      ),
    );

    if (confirmed == true && mounted) {
      try {
        await widget.libraryRepository.deleteStoryHistory(item.story.id);
        setState(() {
          _history.removeWhere((e) => e.story.id == item.story.id);
          if (_continueReading?.story.id == item.story.id) {
            _continueReading = null;
          }
        });
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Lỗi xóa lịch sử: $e'),
              backgroundColor: AppColors.error,
            ),
          );
        }
      }
    }
  }

  Future<void> _confirmClearAllHistory() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.darkSurface,
        title: const Text('Xóa tất cả lịch sử', style: TextStyle(color: AppColors.textPrimary)),
        content: const Text(
          'Toàn bộ lịch sử đọc và tiến độ của bạn sẽ bị xóa. Hành động này không thể hoàn tác.',
          style: TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Hủy'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Xóa tất cả'),
          ),
        ],
      ),
    );

    if (confirmed == true && mounted) {
      try {
        await widget.libraryRepository.clearAllHistory();
        setState(() {
          _history.clear();
          _continueReading = null;
        });
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Lỗi xóa toàn bộ lịch sử: $e'),
              backgroundColor: AppColors.error,
            ),
          );
        }
      }
    }
  }

  void _openReader(ReadingHistoryItem item) {
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.oledBlack,
      appBar: AppBar(
        title: const Text('Tủ sách của tôi'),
        backgroundColor: AppColors.oledBlack,
        elevation: 0,
        actions: [
          if (_tabController.index == 1 && _history.isNotEmpty)
            IconButton(
              key: const Key('clear_all_history_button'),
              icon: const Icon(Icons.delete_sweep, color: AppColors.textMuted),
              tooltip: 'Xóa toàn bộ lịch sử',
              onPressed: _confirmClearAllHistory,
            ),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: context.primaryColor,
          labelColor: context.primaryColor,
          unselectedLabelColor: AppColors.textSecondary,
          tabs: const [
            Tab(text: 'Đang theo dõi'),
            Tab(text: 'Lịch sử'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildBookmarksTab(),
          _buildHistoryTab(),
        ],
      ),
    );
  }

  Widget _buildBookmarksTab() {
    return Column(
      children: [
        // Filter chips
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: LibraryStatusFilter.values.map((filter) {
              final isSelected = _selectedFilter == filter;
              return Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  label: Text(filter.label),
                  selected: isSelected,
                  selectedColor: context.primaryColor.withValues(alpha: 0.25),
                  backgroundColor: AppColors.darkSurface,
                  labelStyle: TextStyle(
                    color: isSelected ? context.primaryColor : AppColors.textSecondary,
                    fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                    fontSize: 13,
                  ),
                  side: BorderSide(
                    color: isSelected ? context.primaryColor : AppColors.darkBorder,
                  ),
                  onSelected: (_) => _onFilterChanged(filter),
                ),
              );
            }).toList(),
          ),
        ),

        // List
        Expanded(
          child: RefreshIndicator(
            onRefresh: _fetchBookmarks,
            color: context.primaryColor,
            child: _buildBookmarksList(),
          ),
        ),
      ],
    );
  }

  Widget _buildBookmarksList() {
    if (_isLoadingBookmarks && _bookmarks.isEmpty) {
      return Center(
        child: CircularProgressIndicator(color: context.primaryColor),
      );
    }

    if (_bookmarksError != null && _bookmarks.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.error, size: 40),
              const SizedBox(height: 12),
              const Text(
                'Không thể tải danh sách theo dõi',
                style: TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 12),
              ElevatedButton(
                onPressed: _fetchBookmarks,
                child: const Text('Thử lại'),
              ),
            ],
          ),
        ),
      );
    }

    if (_bookmarks.isEmpty) {
      return const Center(
        child: Text(
          'Chưa có truyện nào trong danh sách theo dõi',
          style: TextStyle(color: AppColors.textMuted),
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      itemCount: _bookmarks.length,
      itemBuilder: (ctx, idx) {
        final item = _bookmarks[idx];
        return Card(
          color: AppColors.darkSurface,
          margin: const EdgeInsets.only(bottom: 12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
            side: const BorderSide(color: AppColors.darkBorder),
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => context.push('/story/${item.story.slug}'),
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Row(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: Container(
                      width: 60,
                      height: 84,
                      color: AppColors.darkSurfaceElevated,
                      child: item.story.coverUrl != null
                          ? Image.network(
                              item.story.coverUrl!,
                              fit: BoxFit.cover,
                              errorBuilder: (_, __, ___) => Icon(
                                Icons.auto_stories,
                                color: context.primaryColor,
                              ),
                            )
                          : Icon(Icons.auto_stories, color: context.primaryColor),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          item.story.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: AppColors.textPrimary,
                            fontWeight: FontWeight.bold,
                            fontSize: 15,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          '${item.story.totalChapters} chương • ${item.story.status}',
                          style: const TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(height: 8),
                        if (item.unreadChapterCount > 0)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                            decoration: BoxDecoration(
                              color: context.primaryColor.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(color: context.primaryColor.withValues(alpha: 0.4)),
                            ),
                            child: Text(
                              '${item.unreadChapterCount} chương mới',
                              style: TextStyle(
                                color: context.primaryColor,
                                fontSize: 11,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildHistoryTab() {
    return RefreshIndicator(
      onRefresh: _fetchHistory,
      color: context.primaryColor,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Continue Reading Hero Card (Gate 10)
          if (_continueReading != null) ...[
            _buildContinueReadingHeroCard(_continueReading!),
            const SizedBox(height: 20),
          ],

          if (_isLoadingHistory && _history.isEmpty)
            Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: CircularProgressIndicator(color: context.primaryColor),
              ),
            )
          else if (_historyError != null && _history.isEmpty)
            Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline, color: AppColors.error, size: 40),
                    const SizedBox(height: 12),
                    const Text(
                      'Không thể tải lịch sử đọc',
                      style: TextStyle(color: AppColors.textPrimary),
                    ),
                    const SizedBox(height: 12),
                    ElevatedButton(
                      onPressed: _fetchHistory,
                      child: const Text('Thử lại'),
                    ),
                  ],
                ),
              ),
            )
          else if (_history.isEmpty)
            const Center(
              child: Padding(
                padding: EdgeInsets.all(48),
                child: Text(
                  'Bạn chưa có lịch sử đọc truyện nào',
                  style: TextStyle(color: AppColors.textMuted),
                ),
              ),
            )
          else
            ..._history.map((item) => _buildHistoryListItem(item)),
        ],
      ),
    );
  }

  Widget _buildContinueReadingHeroCard(ReadingHistoryItem item) {
    final primary = context.primaryColor;
    final primaryLight = context.primaryLightColor;
    return Container(
      key: const Key('continue_reading_hero_card'),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            primary.withValues(alpha: 0.25),
            AppColors.darkSurface,
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: primary.withValues(alpha: 0.4)),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.history, color: primaryLight, size: 16),
              const SizedBox(width: 6),
              Text(
                'TIẾP TỤC ĐỌC',
                style: TextStyle(
                  color: primaryLight,
                  fontWeight: FontWeight.bold,
                  fontSize: 12,
                  letterSpacing: 1.1,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  width: 55,
                  height: 75,
                  color: AppColors.darkSurfaceElevated,
                  child: item.story.coverUrl != null
                      ? Image.network(
                          item.story.coverUrl!,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Icon(
                            Icons.auto_stories,
                            color: primary,
                          ),
                        )
                      : Icon(Icons.auto_stories, color: primary),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.story.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.textPrimary,
                        fontWeight: FontWeight.bold,
                        fontSize: 16,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Đang đọc: Chương ${item.chapter.chapterNumber} (${item.resume.progressPercentage.toStringAsFixed(0)}%)',
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 13,
                      ),
                    ),
                    const SizedBox(height: 8),
                    ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: context.primaryColor,
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      onPressed: () => _openReader(item),
                      icon: const Icon(Icons.play_arrow, size: 16),
                      label: const Text(
                        'Đọc tiếp',
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildHistoryListItem(ReadingHistoryItem item) {
    return Card(
      color: AppColors.darkSurface,
      margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: const BorderSide(color: AppColors.darkBorder),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => _openReader(item),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  width: 55,
                  height: 75,
                  color: AppColors.darkSurfaceElevated,
                  child: item.story.coverUrl != null
                      ? Image.network(
                          item.story.coverUrl!,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Icon(
                            Icons.auto_stories,
                            color: context.primaryColor,
                          ),
                        )
                      : Icon(Icons.auto_stories, color: context.primaryColor),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.story.title,
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
                      'Chương ${item.chapter.chapterNumber} • ${item.resume.progressPercentage.toStringAsFixed(0)}%',
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                icon: const Icon(Icons.delete_outline, color: AppColors.textMuted, size: 20),
                tooltip: 'Xóa lịch sử truyện này',
                onPressed: () => _confirmDeleteStoryHistory(item),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
