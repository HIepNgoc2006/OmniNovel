import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../app/theme/app_colors.dart';
import '../../story/models/story_models.dart';
import '../../story/repositories/story_repository.dart';

class SearchScreen extends StatefulWidget {
  final StoryRepository storyRepository;
  final String? initialSearch;
  final String? initialGenre;
  final String? initialFormat;
  final String? initialSort;

  const SearchScreen({
    super.key,
    required this.storyRepository,
    this.initialSearch,
    this.initialGenre,
    this.initialFormat,
    this.initialSort,
  });

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  static const String _recentSearchesKey = 'omninovel_recent_searches';

  final TextEditingController _searchController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  Timer? _debounceTimer;

  int _queryGeneration = 0;
  bool _isLoading = false;
  bool _isLoadingMore = false;
  String? _errorMessage;

  List<StorySummary> _stories = [];
  PaginationMeta? _pagination;
  int _currentPage = 1;

  // Filter States
  String? _selectedFormat; // null | 'COMIC' | 'NOVEL'
  String? _selectedGenre; // null | genre.slug
  String? _selectedStatus; // null | 'ONGOING' | 'COMPLETED'
  String _selectedSort = 'LATEST'; // 'LATEST' | 'VIEWS' | 'POPULAR'

  // Dynamic Genres from Server
  List<Genre> _genres = [];
  bool _isLoadingGenres = false;

  // Search History
  List<String> _recentSearches = [];

  @override
  void initState() {
    super.initState();
    if (widget.initialSearch != null) _searchController.text = widget.initialSearch!;
    if (widget.initialGenre != null) _selectedGenre = widget.initialGenre;
    if (widget.initialFormat != null) _selectedFormat = widget.initialFormat;
    if (widget.initialSort != null) _selectedSort = widget.initialSort!;

    _scrollController.addListener(_onScroll);
    _loadRecentSearches();
    _loadGenres();
    _performSearch(isNewQuery: true);
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    _searchController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final maxScroll = _scrollController.position.maxScrollExtent;
    final currentScroll = _scrollController.position.pixels;
    if (currentScroll >= maxScroll - 200) {
      if (!_isLoading && !_isLoadingMore && (_pagination?.hasNextPage ?? false)) {
        _performSearch(isNewQuery: false);
      }
    }
  }

  Future<void> _loadRecentSearches() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final jsonStr = prefs.getString(_recentSearchesKey);
      if (jsonStr != null && jsonStr.isNotEmpty) {
        final decoded = jsonDecode(jsonStr);
        if (decoded is List && mounted) {
          setState(() {
            _recentSearches = decoded.map((e) => e.toString()).toList();
          });
        }
      }
    } catch (_) {}
  }

  Future<void> _saveRecentSearch(String term) async {
    final clean = term.trim();
    if (clean.isEmpty) return;
    try {
      final updated = [clean, ..._recentSearches.where((s) => s != clean)].take(10).toList();
      setState(() {
        _recentSearches = updated;
      });
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_recentSearchesKey, jsonEncode(updated));
    } catch (_) {}
  }

  Future<void> _clearRecentSearches() async {
    try {
      setState(() {
        _recentSearches.clear();
      });
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_recentSearchesKey);
    } catch (_) {}
  }

  Future<void> _loadGenres() async {
    setState(() {
      _isLoadingGenres = true;
    });
    try {
      final list = await widget.storyRepository.getGenres();
      if (mounted) {
        setState(() {
          _genres = list;
          _isLoadingGenres = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _isLoadingGenres = false;
        });
      }
    }
  }

  void _onQueryChanged() {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(const Duration(milliseconds: 500), () {
      _performSearch(isNewQuery: true);
    });
  }

  Future<void> _performSearch({bool isNewQuery = false}) async {
    if (isNewQuery) {
      _queryGeneration++;
    }
    final currentGen = _queryGeneration;

    if (isNewQuery) {
      setState(() {
        _isLoading = true;
        _errorMessage = null;
        _currentPage = 1;
      });
    } else {
      if (_isLoadingMore || !(_pagination?.hasNextPage ?? false)) return;
      setState(() {
        _isLoadingMore = true;
      });
    }

    final queryText = _searchController.text.trim();
    if (queryText.isNotEmpty && isNewQuery) {
      await _saveRecentSearch(queryText);
    }

    try {
      final pageToLoad = isNewQuery ? 1 : _currentPage + 1;
      final res = await widget.storyRepository.getStories(
        FindStoriesParams(
          search: queryText.isEmpty ? null : queryText,
          genre: _selectedGenre,
          format: _selectedFormat,
          status: _selectedStatus,
          sort: _selectedSort,
          page: pageToLoad,
          limit: 20,
        ),
      );

      if (!mounted || currentGen != _queryGeneration) {
        // Discard stale response
        return;
      }

      setState(() {
        _currentPage = pageToLoad;
        _pagination = res.pagination;
        if (isNewQuery) {
          _stories = res.data;
          _isLoading = false;
        } else {
          final existingIds = _stories.map((s) => s.id).toSet();
          final newItems = res.data.where((s) => !existingIds.contains(s.id));
          _stories.addAll(newItems);
          _isLoadingMore = false;
        }
      });
    } catch (e) {
      if (!mounted || currentGen != _queryGeneration) return;
      setState(() {
        _isLoading = false;
        _isLoadingMore = false;
        _errorMessage = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.oledBlack,
      appBar: AppBar(
        backgroundColor: AppColors.oledBlack,
        elevation: 0,
        title: TextField(
          controller: _searchController,
          autofocus: widget.initialSearch == null,
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 16),
          cursorColor: AppColors.primary,
          decoration: InputDecoration(
            hintText: 'Tìm kiếm truyện, tóm tắt...',
            hintStyle: const TextStyle(color: AppColors.textMuted),
            border: InputBorder.none,
            suffixIcon: _searchController.text.isNotEmpty
                ? IconButton(
                    icon: const Icon(Icons.clear, color: AppColors.textMuted),
                    onPressed: () {
                      _searchController.clear();
                      _performSearch(isNewQuery: true);
                    },
                  )
                : null,
          ),
          onChanged: (_) => _onQueryChanged(),
        ),
      ),
      body: Column(
        children: [
          // 1. Filter Chips Row
          _buildFilterBar(),
          const Divider(color: AppColors.darkBorder, height: 1),

          // 2. Results or History Body
          Expanded(child: _buildResultsList()),
        ],
      ),
    );
  }

  Widget _buildFilterBar() {
    return Container(
      color: AppColors.darkBackground,
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          children: [
            // Sort Filter Chip
            PopupMenuButton<String>(
              initialValue: _selectedSort,
              color: AppColors.darkSurfaceElevated,
              tooltip: 'Sắp xếp',
              onSelected: (val) {
                setState(() => _selectedSort = val);
                _performSearch(isNewQuery: true);
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'LATEST', child: Text('Mới nhất', style: TextStyle(color: AppColors.textPrimary))),
                PopupMenuItem(value: 'VIEWS', child: Text('Lượt xem nhiều', style: TextStyle(color: AppColors.textPrimary))),
                PopupMenuItem(value: 'POPULAR', child: Text('Phổ biến nhất', style: TextStyle(color: AppColors.textPrimary))),
              ],
              child: _buildFilterBadge(
                label: _selectedSort == 'VIEWS'
                    ? 'Lượt xem'
                    : _selectedSort == 'POPULAR'
                        ? 'Phổ biến'
                        : 'Mới nhất',
                icon: Icons.sort,
                isActive: _selectedSort != 'LATEST',
              ),
            ),
            const SizedBox(width: 8),

            // Format Filter Chip
            PopupMenuButton<String?>(
              initialValue: _selectedFormat,
              color: AppColors.darkSurfaceElevated,
              tooltip: 'Định dạng',
              onSelected: (val) {
                setState(() => _selectedFormat = val);
                _performSearch(isNewQuery: true);
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: null, child: Text('Tất cả định dạng', style: TextStyle(color: AppColors.textPrimary))),
                PopupMenuItem(value: 'COMIC', child: Text('Truyện tranh (Comic)', style: TextStyle(color: AppColors.textPrimary))),
                PopupMenuItem(value: 'NOVEL', child: Text('Tiểu thuyết (Novel)', style: TextStyle(color: AppColors.textPrimary))),
              ],
              child: _buildFilterBadge(
                label: _selectedFormat == 'COMIC'
                    ? 'Truyện tranh'
                    : _selectedFormat == 'NOVEL'
                        ? 'Tiểu thuyết'
                        : 'Định dạng',
                icon: Icons.category,
                isActive: _selectedFormat != null,
              ),
            ),
            const SizedBox(width: 8),

            // Status Filter Chip
            PopupMenuButton<String?>(
              initialValue: _selectedStatus,
              color: AppColors.darkSurfaceElevated,
              tooltip: 'Tình trạng',
              onSelected: (val) {
                setState(() => _selectedStatus = val);
                _performSearch(isNewQuery: true);
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: null, child: Text('Tất cả tình trạng', style: TextStyle(color: AppColors.textPrimary))),
                PopupMenuItem(value: 'ONGOING', child: Text('Đang tiến hành', style: TextStyle(color: AppColors.textPrimary))),
                PopupMenuItem(value: 'COMPLETED', child: Text('Đã hoàn thành', style: TextStyle(color: AppColors.textPrimary))),
              ],
              child: _buildFilterBadge(
                label: _selectedStatus == 'ONGOING'
                    ? 'Đang tiến hành'
                    : _selectedStatus == 'COMPLETED'
                        ? 'Hoàn thành'
                        : 'Tình trạng',
                icon: Icons.check_circle_outline,
                isActive: _selectedStatus != null,
              ),
            ),
            const SizedBox(width: 8),

            // Genre Filter Chip (Dynamic from Server)
            if (_isLoadingGenres)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 8),
                child: SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary),
                ),
              )
            else if (_genres.isNotEmpty)
              PopupMenuButton<String?>(
                initialValue: _selectedGenre,
                color: AppColors.darkSurfaceElevated,
                tooltip: 'Thể loại',
                onSelected: (val) {
                  setState(() => _selectedGenre = val);
                  _performSearch(isNewQuery: true);
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(value: null, child: Text('Tất cả thể loại', style: TextStyle(color: AppColors.textPrimary))),
                  ..._genres.map(
                    (g) => PopupMenuItem(
                      value: g.slug,
                      child: Text(g.name, style: const TextStyle(color: AppColors.textPrimary)),
                    ),
                  ),
                ],
                child: _buildFilterBadge(
                  label: _selectedGenre != null
                      ? _genres.firstWhere((g) => g.slug == _selectedGenre, orElse: () => Genre(id: 0, name: _selectedGenre!, slug: _selectedGenre!)).name
                      : 'Thể loại',
                  icon: Icons.local_offer_outlined,
                  isActive: _selectedGenre != null,
                ),
              ),

            if (_hasActiveFilters) ...[
              const SizedBox(width: 8),
              ActionChip(
                backgroundColor: AppColors.darkSurfaceElevated,
                label: const Text('Xóa bộ lọc', style: TextStyle(color: Colors.redAccent, fontSize: 11)),
                onPressed: () {
                  setState(() {
                    _selectedFormat = null;
                    _selectedGenre = null;
                    _selectedStatus = null;
                    _selectedSort = 'LATEST';
                  });
                  _performSearch(isNewQuery: true);
                },
              ),
            ],
          ],
        ),
      ),
    );
  }

  bool get _hasActiveFilters =>
      _selectedFormat != null || _selectedGenre != null || _selectedStatus != null || _selectedSort != 'LATEST';

  Widget _buildFilterBadge({required String label, required IconData icon, required bool isActive}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: isActive ? AppColors.primary.withValues(alpha: 0.25) : AppColors.darkSurface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: isActive ? AppColors.primary : AppColors.darkBorder,
          width: 1,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: isActive ? AppColors.primaryLight : AppColors.textMuted),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              color: isActive ? AppColors.primaryLight : AppColors.textPrimary,
              fontSize: 12,
              fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
            ),
          ),
          const SizedBox(width: 4),
          Icon(Icons.arrow_drop_down, size: 16, color: isActive ? AppColors.primaryLight : AppColors.textMuted),
        ],
      ),
    );
  }

  Widget _buildResultsList() {
    // Nếu chưa nhập từ khóa, chưa có bộ lọc và có lịch sử, hiển thị lịch sử tìm kiếm gần đây
    if (_searchController.text.trim().isEmpty && !_hasActiveFilters && _recentSearches.isNotEmpty) {
      return _buildRecentSearchesSection();
    }

    if (_isLoading) {
      return const Center(child: CircularProgressIndicator(color: AppColors.primary));
    }

    if (_errorMessage != null && _stories.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.error, size: 48),
              const SizedBox(height: 12),
              Text(_errorMessage!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textPrimary)),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () => _performSearch(isNewQuery: true),
                child: const Text('Thử lại'),
              ),
            ],
          ),
        ),
      );
    }

    if (_stories.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.search_off, color: AppColors.textMuted, size: 64),
              SizedBox(height: 16),
              Text(
                'Không tìm thấy truyện phù hợp',
                style: TextStyle(color: AppColors.textPrimary, fontSize: 16, fontWeight: FontWeight.bold),
              ),
              SizedBox(height: 8),
              Text(
                'Hãy thử thay đổi từ khóa hoặc điều chỉnh bộ lọc tìm kiếm.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textMuted, fontSize: 13),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () => _performSearch(isNewQuery: true),
      color: AppColors.primary,
      child: ListView.separated(
        controller: _scrollController,
        padding: const EdgeInsets.all(16),
        itemCount: _stories.length + (_isLoadingMore ? 1 : 0),
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (context, index) {
          if (index == _stories.length) {
            return const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Center(
                child: SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary),
                ),
              ),
            );
          }

          final story = _stories[index];
          final format = (story.publicationFormat ?? story.mediaFormat).toUpperCase();

          return InkWell(
            onTap: () => context.push('/story/${story.slug}'),
            borderRadius: BorderRadius.circular(10),
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.darkSurface,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.darkBorder),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: Container(
                      width: 60,
                      height: 82,
                      color: AppColors.darkSurfaceElevated,
                      child: story.coverUrl != null && story.coverUrl!.isNotEmpty
                          ? Image.network(
                              story.coverUrl!,
                              fit: BoxFit.cover,
                              errorBuilder: (_, __, ___) => const Icon(Icons.auto_stories, color: AppColors.primary),
                            )
                          : const Icon(Icons.auto_stories, color: AppColors.primary),
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
                          style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
                        ),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: AppColors.primary.withValues(alpha: 0.2),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                format,
                                style: const TextStyle(color: AppColors.primaryLight, fontSize: 9, fontWeight: FontWeight.bold),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              '${story.viewsCount} lượt xem',
                              style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                            ),
                            if (story.status == 'COMPLETED') ...[
                              const SizedBox(width: 8),
                              const Text('• Full', style: TextStyle(color: Colors.greenAccent, fontSize: 11)),
                            ],
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildRecentSearchesSection() {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Tìm kiếm gần đây',
                style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.bold, fontSize: 14),
              ),
              TextButton(
                onPressed: _clearRecentSearches,
                child: const Text('Xóa tất cả', style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: _recentSearches.map((term) {
              return InputChip(
                backgroundColor: AppColors.darkSurface,
                label: Text(term, style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                onPressed: () {
                  _searchController.text = term;
                  _performSearch(isNewQuery: true);
                },
                deleteIcon: const Icon(Icons.close, size: 14, color: AppColors.textMuted),
                onDeleted: () {
                  setState(() {
                    _recentSearches.remove(term);
                  });
                  SharedPreferences.getInstance().then((prefs) {
                    prefs.setString(_recentSearchesKey, jsonEncode(_recentSearches));
                  });
                },
              );
            }).toList(),
          ),
        ],
      ),
    );
  }
}
