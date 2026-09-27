import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../../reader/models/reading_progress_models.dart';

/// Interface cung cấp danh sách các [chapterVersionId] đang được checkpoint tiến độ đọc bảo vệ.
/// Giúp [StorageQuotaManager] tự động loại trừ các chương này khỏi danh sách dọn dẹp LRU
/// mà không phụ thuộc vào việc caller có nhớ truyền thủ công hay không.
abstract interface class ActiveCheckpointProvider {
  /// Trả về tập hợp các chapterVersionId được bảo vệ của người dùng hiện tại.
  Future<Set<String>> getProtectedVersionIds();
}

/// Triển khai mặc định của [ActiveCheckpointProvider] đọc trực tiếp từ SharedPreferences
/// dựa trên các checkpoint cục bộ của [ReadingProgressRepository].
class SharedPreferencesCheckpointProvider implements ActiveCheckpointProvider {
  final Future<SharedPreferences> Function()? _prefsProvider;
  final SharedPreferences? _prefs;
  final String _userId;

  final Duration _protectionWindow;
  final double _completedProgressThreshold;

  static const String _checkpointPrefix = 'omninovel_reading_checkpoint_';

  SharedPreferencesCheckpointProvider({
    required String userId,
    SharedPreferences? prefs,
    Future<SharedPreferences> Function()? prefsProvider,
    Duration protectionWindow = const Duration(days: 7),
    double completedProgressThreshold = 100.0,
  })  : _userId = userId,
        _prefs = prefs,
        _prefsProvider = prefsProvider,
        _protectionWindow = protectionWindow,
        _completedProgressThreshold = completedProgressThreshold;

  Future<SharedPreferences> _getPrefs() async {
    if (_prefs != null) return _prefs;
    if (_prefsProvider != null) return await _prefsProvider();
    return await SharedPreferences.getInstance();
  }

  @override
  Future<Set<String>> getProtectedVersionIds() async {
    final prefs = await _getPrefs();
    final userPrefix = '$_checkpointPrefix${_userId}_';
    final protectedIds = <String>{};
    final now = DateTime.now();

    final allKeys = prefs.getKeys().where((k) => k.startsWith(userPrefix));
    for (final key in allKeys) {
      final raw = prefs.getString(key);
      if (raw == null || raw.isEmpty) continue;

      try {
        final json = jsonDecode(raw) as Map<String, dynamic>;
        final checkpoint = LocalReadingCheckpoint.fromJson(json);
        final vId = checkpoint.chapterVersionId;
        if (vId == null || vId.trim().isEmpty) continue;

        // P1 Invariant: Chỉ bảo vệ khi chưa hoàn thành 100% VÀ còn trong cửa sổ bảo vệ
        final isCompleted = checkpoint.progressPercentage >= _completedProgressThreshold;
        final isExpired = now.difference(checkpoint.updatedAt) > _protectionWindow;

        if (!isCompleted && !isExpired) {
          protectedIds.add(vId.trim());
        }
      } catch (_) {
        // Bỏ qua bản ghi hỏng/không hợp lệ
      }
    }

    return protectedIds;
  }
}

/// Triển khai In-Memory phục vụ Unit Tests và các kịch bản kiểm thử cô lập.
class InMemoryCheckpointProvider implements ActiveCheckpointProvider {
  final Set<String> _protectedVersionIds;

  InMemoryCheckpointProvider([Set<String>? initial])
      : _protectedVersionIds = Set<String>.from(initial ?? const <String>{});

  void protect(String versionId) => _protectedVersionIds.add(versionId);
  void unprotect(String versionId) => _protectedVersionIds.remove(versionId);
  void clear() => _protectedVersionIds.clear();

  @override
  Future<Set<String>> getProtectedVersionIds() async => Set<String>.unmodifiable(_protectedVersionIds);
}
