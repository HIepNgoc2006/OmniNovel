import 'dart:async';
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/error_mapper.dart';
import '../../reader/repositories/reading_progress_repository.dart';
import '../models/library_models.dart';

class LibraryRepository {
  final ApiClient _apiClient;
  final ReadingProgressRepository _progressRepository;
  final SharedPreferences? _prefs;
  final String? Function()? _userIdProvider;

  static const String _libraryCachePrefix = 'omninovel_library_';

  LibraryRepository({
    required ApiClient apiClient,
    required ReadingProgressRepository progressRepository,
    SharedPreferences? prefs,
    String? Function()? userIdProvider,
  })  : _apiClient = apiClient,
        _progressRepository = progressRepository,
        _prefs = prefs,
        _userIdProvider = userIdProvider;

  String _uid() => _userIdProvider?.call() ?? 'anon';

  String _historyCacheKey() => '$_libraryCachePrefix${_uid()}_history_page1';
  String _continueReadingKey() =>
      '$_libraryCachePrefix${_uid()}_continue_reading';
  String _bookmarksCacheKey(String? status) =>
      '$_libraryCachePrefix${_uid()}_bookmarks_${status ?? 'ALL'}';

  Future<SharedPreferences> get _asyncPrefs async =>
      _prefs ?? await SharedPreferences.getInstance();

  // ==================== BOOKMARKS ====================

  /// Lấy trạng thái bookmark của một story
  Future<BookmarkStatusResponse> getBookmarkStatus(String storyId) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.storyBookmarkStatus(storyId),
      );
      final data = response.data ?? <String, dynamic>{};
      return BookmarkStatusResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Thêm hoặc gỡ bookmark
  Future<BookmarkStatusResponse> setBookmark(
      String storyId, bool isBookmarked) async {
    try {
      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.libraryBookmarks,
        data: {'storyId': storyId, 'isBookmarked': isBookmarked},
      );
      final data = response.data ?? <String, dynamic>{};
      return BookmarkStatusResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Đọc snapshot bookmarks cục bộ theo status (Stale-While-Revalidate)
  List<BookmarkedStoryItem> getCachedBookmarks({String? status}) {
    final prefs = _prefs;
    if (prefs == null) return [];
    final raw = prefs.getString(_bookmarksCacheKey(status));
    if (raw == null || raw.isEmpty) return [];

    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list
          .map((e) => BookmarkedStoryItem.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Fetch bookmarks từ server và lưu snapshot nếu là page 1
  Future<PaginatedBookmarksResponse> fetchBookmarks({
    int page = 1,
    int limit = 20,
    String? status,
  }) async {
    try {
      final queryParams = <String, dynamic>{
        'page': page,
        'limit': limit,
        if (status != null && status.isNotEmpty) 'status': status,
      };

      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.libraryBookmarks,
        queryParameters: queryParams,
      );
      final data = response.data ?? <String, dynamic>{};
      final result = PaginatedBookmarksResponse.fromJson(data);

      if (page == 1) {
        final prefs = await _asyncPrefs;
        await prefs.setString(
          _bookmarksCacheKey(status),
          jsonEncode(result.data.map((e) => e.toJson()).toList()),
        );
      }

      return result;
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  // ==================== READING HISTORY ====================

  /// Đọc snapshot lịch sử đọc cục bộ (Stale-While-Revalidate)
  List<ReadingHistoryItem> getCachedHistory() {
    final prefs = _prefs;
    if (prefs == null) return [];
    final raw = prefs.getString(_historyCacheKey());
    if (raw == null || raw.isEmpty) return [];

    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list
          .map((e) => ReadingHistoryItem.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Fetch lịch sử đọc từ server (chỉ page 1 && updateCache mới ghi đè history snapshot)
  Future<PaginatedReadingHistoryResponse> fetchHistory({
    int page = 1,
    int limit = 20,
    bool updateCache = true,
  }) async {
    try {
      final queryParams = <String, dynamic>{
        'page': page,
        'limit': limit,
      };

      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.libraryHistory,
        queryParameters: queryParams,
      );
      final data = response.data ?? <String, dynamic>{};
      final result = PaginatedReadingHistoryResponse.fromJson(data);

      if (page == 1 && updateCache) {
        final prefs = await _asyncPrefs;
        await prefs.setString(
          _historyCacheKey(),
          jsonEncode(result.data.map((e) => e.toJson()).toList()),
        );
      }

      return result;
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lấy snapshot Continue Reading đã lưu
  ReadingHistoryItem? getCachedContinueReading() {
    final prefs = _prefs;
    if (prefs == null) return null;
    final raw = prefs.getString(_continueReadingKey());
    if (raw == null || raw.isEmpty) return null;

    try {
      final json = jsonDecode(raw) as Map<String, dynamic>;
      return ReadingHistoryItem.fromJson(json);
    } catch (_) {
      return null;
    }
  }

  /// Lấy item đọc tiếp gần nhất (Hero Card) - không cắt cụt history cache
  Future<ReadingHistoryItem?> getContinueReading() async {
    try {
      final res = await fetchHistory(page: 1, limit: 1, updateCache: false);
      if (res.data.isNotEmpty) {
        final item = res.data.first;
        final prefs = await _asyncPrefs;
        await prefs.setString(_continueReadingKey(), jsonEncode(item.toJson()));
        return item;
      } else {
        final prefs = await _asyncPrefs;
        await prefs.remove(_continueReadingKey());
        return null;
      }
    } catch (_) {
      return getCachedContinueReading();
    }
  }

  /// Xóa lịch sử đọc của 1 story có Rollback và Invalidation an toàn
  Future<void> deleteStoryHistory(String storyId) async {
    // 1. Invalidate pending write để không ai gửi write cũ
    _progressRepository.invalidateStory(storyId);

    // 2. Snapshot checkpoint cũ đề phòng rollback
    final backupCheckpoint =
        await _progressRepository.getLocalCheckpoint(storyId);

    try {
      await _apiClient.delete<dynamic>(ApiEndpoints.libraryHistoryStory(storyId));

      // Thành công -> xóa checkpoint và cập nhật snapshot
      await _progressRepository.clearLocalCheckpoint(storyId);
      final cached = getCachedHistory();
      final updated = cached.where((e) => e.story.id != storyId).toList();
      final prefs = await _asyncPrefs;
      await prefs.setString(
        _historyCacheKey(),
        jsonEncode(updated.map((e) => e.toJson()).toList()),
      );

      final continueReading = getCachedContinueReading();
      if (continueReading?.story.id == storyId) {
        await prefs.remove(_continueReadingKey());
      }
    } on ApiError {
      if (backupCheckpoint != null) {
        await _progressRepository.saveLocalCheckpoint(backupCheckpoint);
      }
      unawaited(fetchHistory(page: 1, limit: 20).then((_) {}).catchError((_) {}));
      rethrow;
    } catch (e) {
      if (backupCheckpoint != null) {
        await _progressRepository.saveLocalCheckpoint(backupCheckpoint);
      }
      unawaited(fetchHistory(page: 1, limit: 20).then((_) {}).catchError((_) {}));
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Xóa toàn bộ lịch sử đọc
  Future<void> clearAllHistory() async {
    _progressRepository.invalidateAllStories();

    try {
      await _apiClient.delete<dynamic>(ApiEndpoints.libraryHistory);
      await _progressRepository.clearAllLocalCheckpoints();

      final prefs = await _asyncPrefs;
      await prefs.remove(_historyCacheKey());
      await prefs.remove(_continueReadingKey());
    } on ApiError {
      unawaited(fetchHistory(page: 1, limit: 20).then((_) {}).catchError((_) {}));
      rethrow;
    } catch (e) {
      unawaited(fetchHistory(page: 1, limit: 20).then((_) {}).catchError((_) {}));
      throw ErrorMapper.fromGeneric(e);
    }
  }
}
