import 'dart:math' as math;

import '../../storage/local_library_models.dart';
import '../errors/sync_storage_exceptions.dart';

/// UUID Sentinel chuẩn của Core API cho thao tác Global HISTORY DELETE (`all`).
const String kGlobalHistorySentinelUuid = '00000000-0000-0000-0000-000000000000';

/// Alias đầu vào được chấp nhận khi tham chiếu Global HISTORY DELETE.
const String kGlobalHistoryAlias = 'all';

/// Các chế độ đọc hợp lệ theo Canonical Sync DTO (`packages/shared`).
const List<String> kValidSyncReadingModes = <String>[
  'WEBTOON',
  'PAGED',
  'NOVEL',
];

/// Kiểm tra [scope] có phải Guest scope (`guest:<guestProfileId>`) hợp lệ hay không.
bool isGuestScope(String? scope) {
  if (scope == null || scope != scope.trim()) return false;
  if (!scope.startsWith('guest:')) return false;
  return scope.substring('guest:'.length).trim().isNotEmpty;
}

/// Kiểm tra [scope] có phải Account scope (`account:<userId>`) hợp lệ hay không.
bool isAccountScope(String? scope) {
  if (scope == null || scope != scope.trim()) return false;
  if (!scope.startsWith('account:')) return false;
  return scope.substring('account:'.length).trim().isNotEmpty;
}

/// Xác thực [scope] là non-empty canonical scope (`guest:<id>` hoặc `account:<id>`).
/// Ném [InvalidSyncScopeException] nếu rỗng hoặc sai định dạng.
String assertValidScope(String? scope) {
  if (!isGuestScope(scope) && !isAccountScope(scope)) {
    throw InvalidSyncScopeException(scope);
  }
  return scope!;
}

/// Xác thực [scope] bắt buộc thuộc `account:<userId>`.
String assertAccountScope(String? scope) {
  if (!isAccountScope(scope)) {
    throw InvalidSyncScopeException(
      scope,
      'Invalid account scope "$scope". Strictly requires "account:<userId>".',
    );
  }
  return scope!;
}

/// Kiểm tra [entityId] có tham chiếu tới Global HISTORY DELETE (`all` hoặc sentinel UUID) hay không (M4).
bool isGlobalHistoryTarget(String entityId) {
  return entityId == kGlobalHistorySentinelUuid ||
      entityId == kGlobalHistoryAlias;
}

/// Key chuẩn cho Bookmark shadow (`storyId`).
String canonicalBookmarkEntityKey(String storyId) => storyId;

/// Key chuẩn cho Progress shadow (`storyId`).
String canonicalProgressEntityKey(String storyId) => storyId;

/// Key chuẩn cho Preference shadow (`prefKey`).
String canonicalPreferenceEntityKey(String prefKey) => prefKey;

/// Key chuẩn cho History shadow (`$storyId:$chapterId`).
String canonicalHistoryEntityKey(String storyId, String chapterId) =>
    '$storyId:$chapterId';

/// Tính effective history epoch cho [storyId] theo công thức:
/// `max(storyEpoch ?? 0, globalEpoch ?? 0)`.
int getEffectiveHistoryEpoch(Map<String, int> effectiveEpochs, String storyId) {
  final storyEpoch = effectiveEpochs[storyId] ?? 0;
  final globalEpoch = effectiveEpochs[kGlobalHistorySentinelUuid] ?? 0;
  return math.max(storyEpoch, globalEpoch);
}

/// So sánh hai map `effectiveHistoryEpochs` không phụ thuộc thứ tự khóa.
bool areEpochMapsEqual(Map<String, int>? a, Map<String, int>? b) {
  if (identical(a, b)) return true;
  if (a == null || b == null) return a == null && b == null;
  if (a.length != b.length) return false;
  for (final entry in a.entries) {
    if (b[entry.key] != entry.value) return false;
  }
  return true;
}

/// Chuẩn hóa `readingMode` từ Mobile v3 (`MANGA_PAGED`) sang Canonical Sync DTO (M2):
/// `'WEBTOON' | 'PAGED' | 'NOVEL'`.
String normalizeSyncReadingMode(String? readingMode) {
  switch (readingMode?.trim().toUpperCase()) {
    case 'NOVEL':
      return 'NOVEL';
    case 'PAGED':
    case 'MANGA_PAGED':
      return 'PAGED';
    case 'WEBTOON':
    default:
      return 'WEBTOON';
  }
}

/// Đóng gói payload Canonical `PROGRESS UPSERT` từ [LocalReadingProgress],
/// chuẩn hóa M2 (`MANGA_PAGED` -> `PAGED`) và ép `pageIndex >= 1`.
Map<String, Object?> buildSyncProgressPayload(
  LocalReadingProgress progress, {
  int? observedHistoryEpoch,
}) {
  return <String, Object?>{
    'storyId': progress.storyId,
    'chapterId': progress.chapterId,
    'chapterVersionId': progress.chapterVersionId,
    'readingMode': normalizeSyncReadingMode(progress.readingMode),
    'pageIndex': progress.pageIndex >= 1 ? progress.pageIndex : 1,
    'scrollPosition': progress.scrollPosition,
    'progressPercentage': progress.progressPercentage,
    'anchorBlockId': progress.anchorBlockId,
    'textOffset': progress.textOffset,
    if (observedHistoryEpoch != null)
      'observedHistoryEpoch': observedHistoryEpoch,
  };
}

/// Escape các ký tự wildcard trong SQLite `LIKE ... ESCAPE '\'` (`\`, `%`, `_`)
/// để cascade delete theo `story_id:` không xóa nhầm story khác (ví dụ `story_1` vs `story-1`).
String escapeSqlLikePattern(String raw) {
  return raw
      .replaceAll(r'\', r'\\')
      .replaceAll('%', r'\%')
      .replaceAll('_', r'\_');
}
