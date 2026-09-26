import 'dart:async';
import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/error_mapper.dart';
import '../models/reading_progress_models.dart';

class ReadingProgressRepository {
  final ApiClient _apiClient;
  final SharedPreferences? _prefs;
  final String? Function()? _userIdProvider;

  static const String _checkpointPrefix = 'omninovel_reading_checkpoint_';
  static const String _epochPrefix = 'omninovel_canonical_epoch_';

  // Canonical server epoch map (chỉ nạp từ server qua getProgress hoặc echo)
  final Map<String, int> _storyServerEpochs = {};

  // Cache response tiến độ đọc mới nhất từ server
  final Map<String, ReadingProgressResponse> _cachedServerProgress = {};

  // Local generation counter (dùng để drop debounced writes và cancel tokens)
  final Map<String, int> _localWriteGenerations = {};

  // Cancel tokens cho request HTTP in-flight
  final Map<String, CancelToken> _inFlightTokens = {};

  ReadingProgressRepository({
    required ApiClient apiClient,
    SharedPreferences? prefs,
    String? Function()? userIdProvider,
  })  : _apiClient = apiClient,
        _prefs = prefs,
        _userIdProvider = userIdProvider;

  String _getCheckpointKey(String storyId) {
    final uid = _userIdProvider?.call() ?? 'anon';
    return '$_checkpointPrefix${uid}_$storyId';
  }

  String _getEpochKey(String storyId) {
    final uid = _userIdProvider?.call() ?? 'anon';
    return '$_epochPrefix${uid}_$storyId';
  }

  Future<void> _persistEpoch(String storyId, int epoch) async {
    try {
      final prefs = _prefs ?? await SharedPreferences.getInstance();
      final key = _getEpochKey(storyId);
      await prefs.setInt(key, epoch);
    } catch (_) {}
  }

  Future<void> _clearPersistedEpoch(String storyId) async {
    try {
      final prefs = _prefs ?? await SharedPreferences.getInstance();
      final key = _getEpochKey(storyId);
      await prefs.remove(key);
    } catch (_) {}
  }

  Future<void> _clearAllPersistedEpochs() async {
    try {
      final prefs = _prefs ?? await SharedPreferences.getInstance();
      final uid = _userIdProvider?.call() ?? 'anon';
      final prefix = '$_epochPrefix${uid}_';
      final keys = prefs.getKeys().where((k) => k.startsWith(prefix)).toList();
      for (final k in keys) {
        await prefs.remove(k);
      }
    } catch (_) {}
  }

  /// Lấy epoch đã cache trong session hoặc trên đĩa (disk fallback)
  int? getCachedServerEpoch(String storyId) {
    final ram = _storyServerEpochs[storyId];
    if (ram != null) return ram;
    final disk = _prefs?.getInt(_getEpochKey(storyId));
    if (disk != null) {
      _storyServerEpochs[storyId] = disk;
      return disk;
    }
    return null;
  }

  /// Đọc canonical server epoch đã persist trên đĩa theo user/story
  Future<int?> getLastKnownServerEpoch(String storyId) async {
    final cached = _storyServerEpochs[storyId];
    if (cached != null) return cached;
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    final key = _getEpochKey(storyId);
    final val = prefs.getInt(key);
    if (val != null) {
      _storyServerEpochs[storyId] = val;
    }
    return val;
  }

  /// Lấy response tiến độ đọc đã cache từ server
  ReadingProgressResponse? getCachedServerProgress(String storyId) => _cachedServerProgress[storyId];

  /// Gán canonical server epoch khi nhận response từ server
  void setServerEpoch(String storyId, int epoch) {
    _storyServerEpochs[storyId] = epoch;
    unawaited(_persistEpoch(storyId, epoch));
  }

  /// Lấy local generation của một truyện
  int getLocalGeneration(String storyId) => _localWriteGenerations[storyId] ?? 0;

  /// Bắt buộc hydrate canonical server epoch trước khi enable server write session (P0.3 Zero-fallback)
  Future<int> ensureServerEpoch(String storyId) async {
    final cached = _storyServerEpochs[storyId];
    if (cached != null) return cached;

    final progress = await getProgress(storyId);
    final epoch = progress.writeEpoch;
    _storyServerEpochs[storyId] = epoch;
    unawaited(_persistEpoch(storyId, epoch));
    return epoch;
  }

  /// Hủy write session của một truyện (chống Zombie Resurrection sau DELETE)
  void invalidateStory(String storyId) {
    _localWriteGenerations[storyId] = (_localWriteGenerations[storyId] ?? 0) + 1;
    _inFlightTokens[storyId]?.cancel('History invalidated');
    _inFlightTokens.remove(storyId);
    _storyServerEpochs.remove(storyId);
    _cachedServerProgress.remove(storyId);
    unawaited(_clearPersistedEpoch(storyId));
  }

  /// Hủy write session của toàn bộ truyện
  void invalidateAllStories() {
    for (final token in _inFlightTokens.values) {
      token.cancel('All history invalidated');
    }
    _inFlightTokens.clear();
    for (final key in _localWriteGenerations.keys.toList()) {
      _localWriteGenerations[key] = (_localWriteGenerations[key] ?? 0) + 1;
    }
    _storyServerEpochs.clear();
    _cachedServerProgress.clear();
    unawaited(_clearAllPersistedEpochs());
  }

  /// Lưu tiến độ đọc lên server Core API (yêu cầu payload đã materialize với canonical epoch)
  Future<ReadingProgressResponse> saveProgress(
    ReadingProgressPayload payload, {
    CancelToken? cancelToken,
  }) async {
    final storyKey = payload.storyId;
    final token = cancelToken ?? CancelToken();
    if (storyKey != null) {
      _inFlightTokens[storyKey] = token;
    }

    try {
      final response = await _apiClient.put<Map<String, dynamic>>(
        ApiEndpoints.readingProgress,
        data: payload.toJson(),
        cancelToken: token,
      );
      final data = response.data ?? <String, dynamic>{};

      // Xử lý STALE_WRITE_EPOCH từ server (P0.4)
      if (data['ignored'] == true && data['reason'] == 'STALE_WRITE_EPOCH') {
        if (storyKey != null) {
          _storyServerEpochs.remove(storyKey);
          _cachedServerProgress.remove(storyKey);
          unawaited(_clearPersistedEpoch(storyKey));
        }
        throw StaleWriteEpochException(
          storyId: storyKey ?? '',
          writeEpoch: payload.writeEpoch,
          currentEpoch: data['currentEpoch'] as int?,
        );
      }

      final result = ReadingProgressResponse.fromJson(data);
      if (storyKey != null) {
        _storyServerEpochs[storyKey] = result.writeEpoch;
        _cachedServerProgress[storyKey] = result;
        unawaited(_persistEpoch(storyKey, result.writeEpoch));
      }
      return result;
    } on DioException catch (e) {
      if (CancelToken.isCancel(e)) {
        throw ErrorMapper.fromGeneric('Request cancelled: ${e.message}');
      }
      rethrow;
    } on ApiError {
      rethrow;
    } catch (e) {
      if (e is StaleWriteEpochException) rethrow;
      throw ErrorMapper.fromGeneric(e);
    } finally {
      if (storyKey != null && _inFlightTokens[storyKey] == token) {
        _inFlightTokens.remove(storyKey);
      }
    }
  }

  /// Lấy tiến độ đọc của một bộ truyện từ server
  Future<ReadingProgressResponse> getProgress(String storyId) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.storyReadingProgress(storyId),
      );
      final data = response.data ?? <String, dynamic>{};
      final result = ReadingProgressResponse.fromJson(data);
      _storyServerEpochs[storyId] = result.writeEpoch;
      _cachedServerProgress[storyId] = result;
      unawaited(_persistEpoch(storyId, result.writeEpoch));
      return result;
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lưu checkpoint tức thì vào SharedPreferences (User-scoped)
  Future<void> saveLocalCheckpoint(LocalReadingCheckpoint checkpoint) async {
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    final key = _getCheckpointKey(checkpoint.storyId);
    await prefs.setString(key, jsonEncode(checkpoint.toJson()));
  }

  /// Đọc checkpoint cục bộ từ SharedPreferences (User-scoped)
  Future<LocalReadingCheckpoint?> getLocalCheckpoint(String storyId) async {
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    final key = _getCheckpointKey(storyId);
    final raw = prefs.getString(key);
    if (raw == null || raw.isEmpty) return null;

    try {
      final json = jsonDecode(raw) as Map<String, dynamic>;
      return LocalReadingCheckpoint.fromJson(json);
    } catch (_) {
      return null;
    }
  }

  /// Xóa checkpoint cục bộ của một bộ truyện (User-scoped)
  Future<void> clearLocalCheckpoint(String storyId) async {
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    final key = _getCheckpointKey(storyId);
    await prefs.remove(key);
  }

  /// Xóa toàn bộ checkpoint cục bộ của user hiện tại
  Future<void> clearAllLocalCheckpoints() async {
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    final uid = _userIdProvider?.call() ?? 'anon';
    final prefix = '$_checkpointPrefix${uid}_';
    final keys = prefs.getKeys().where((k) => k.startsWith(prefix)).toList();
    for (final k in keys) {
      await prefs.remove(k);
    }
  }
}
