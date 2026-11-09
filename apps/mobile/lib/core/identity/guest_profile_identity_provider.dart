import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';

import '../storage/offline_database.dart';
import 'installation_identity_provider.dart';

/// Ném khi chuyển đổi vòng đời Guest vi phạm tính đơn điệu (ví dụ cố quarantine
/// hoặc claim một `guestProfileId` đã mang terminal `PURGED` tombstone).
class GuestLifecycleStateError extends StateError {
  GuestLifecycleStateError(super.message);
}

class GuestProfileIdentityProvider {
  static const keyGuestProfileId = 'omninovel_guest_profile_id';

  /// Legacy SharedPreferences key (Stage 1 v5). Từ Stage 1B (SQLite v6), key này
  /// chỉ đóng vai trò READ-ONLY SHADOW để di trú/fallback khi chưa migrate xong;
  /// mọi thao tác `quarantineGuestScope` mới TUYỆT ĐỐI KHÔNG ghi vào key này.
  static const keyQuarantinedProfiles = 'omninovel_quarantined_guest_profiles';
  static const keyQuarantinedProfilesMigratedV6 =
      'omninovel_quarantined_profiles_migrated_v6';

  static const Duration _defaultBusyRetryTimeout = Duration(milliseconds: 5000);

  SharedPreferences? _prefs;
  final OfflineDatabase? _offlineDatabase;
  String? _cachedProfileId;
  Future<void>? _inFlightMigration;

  GuestProfileIdentityProvider({
    SharedPreferences? prefs,
    OfflineDatabase? offlineDatabase,
  })  : _prefs = prefs,
        _offlineDatabase = offlineDatabase;

  bool get hasSqliteAuthority {
    final dbManager = _offlineDatabase;
    return dbManager != null && dbManager.isInitialized;
  }

  Future<SharedPreferences> _getPrefs() async {
    final p = _prefs;
    if (p != null) return p;
    final instance = await SharedPreferences.getInstance();
    _prefs = instance;
    return instance;
  }

  static bool _isSqliteBusyException(DatabaseException error) {
    final code = error.getResultCode();
    if (code != null) {
      return (code & 0xFF) == 5;
    }
    final normalized = error.toString().toLowerCase();
    if (normalized.contains('database table is locked')) {
      return false;
    }
    return normalized.contains('database is locked') ||
        normalized.contains('sqlite_busy');
  }

  Future<T> _runSqliteWriteTransaction<T>(
    Database db,
    Future<T> Function(Transaction txn) action,
  ) async {
    final stopwatch = Stopwatch()..start();
    var attempt = 0;

    while (true) {
      var enteredAction = false;
      try {
        return await db.transaction<T>((txn) async {
          enteredAction = true;
          return await action(txn);
        });
      } on DatabaseException catch (e) {
        if (enteredAction || !_isSqliteBusyException(e)) {
          rethrow;
        }
        final remaining = _defaultBusyRetryTimeout - stopwatch.elapsed;
        if (remaining <= Duration.zero) {
          rethrow;
        }
        attempt++;
        final baseMs = math.min(50, 10 * (1 << math.min(attempt - 1, 3)));
        final delayMs = math.min(baseMs, remaining.inMilliseconds);
        await Future<void>.delayed(
          Duration(milliseconds: delayMs > 0 ? delayMs : 1),
        );
      }
    }
  }

  Future<bool> _hasTable(DatabaseExecutor exec, String tableName) async {
    final rows = await exec.rawQuery(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;",
      <Object?>[tableName],
    );
    return rows.isNotEmpty;
  }

  Future<bool> _hasV6LifecycleTables(DatabaseExecutor exec) async {
    return (await _hasTable(exec, 'guest_quarantined_scopes')) &&
        (await _hasTable(exec, 'guest_purged_tombstones'));
  }

  Set<String> _readCleanedLegacyQuarantinedPrefs(SharedPreferences prefs) {
    final raw = prefs.getStringList(keyQuarantinedProfiles);
    if (raw == null || raw.isEmpty) {
      return const <String>{};
    }
    final cleaned = <String>{};
    for (final item in raw) {
      final normalized = item.trim();
      if (normalized.isNotEmpty) {
        cleaned.add(normalized);
      }
    }
    return cleaned;
  }

  DatabaseExecutor? _resolveExecutor(Transaction? txn) {
    if (txn != null) return txn;
    final db = _offlineDatabase;
    if (db != null && db.isInitialized) {
      return db.database;
    }
    return null;
  }

  Future<String> _generateFreshEligibleGuestId({Transaction? txn}) async {
    for (var attempt = 0; attempt < 8; attempt++) {
      final candidate = generateUUIDv4();
      final isPurged = await isGuestScopePurged(candidate, txn: txn);
      if (isPurged) continue;
      final isQuarantined = await isGuestScopeQuarantined(candidate, txn: txn);
      if (!isQuarantined) {
        return candidate;
      }
    }
    return generateUUIDv4();
  }

  /// Đọc `guestProfileId` hiện đang lưu trên RAM/Prefs mà KHÔNG tự ý tạo mới hay xoay ID.
  /// Hữu ích cho lifecycle guard khi cần kiểm tra trạng thái `PURGED`/`QUARANTINED` của ID cũ.
  Future<String?> peekGuestProfileId() async {
    final cached = _cachedProfileId;
    if (cached != null && cached.isNotEmpty) {
      return cached;
    }
    final prefs = await _getPrefs();
    final existing = prefs.getString(keyGuestProfileId);
    if (existing != null && existing.isNotEmpty) {
      return existing;
    }
    return null;
  }

  /// Kiểm tra `guestProfileId` đã mang terminal `PURGED` tombstone trong SQLite chưa.
  Future<bool> isGuestScopePurged(
    String profileId, {
    Transaction? txn,
  }) async {
    final trimmed = profileId.trim();
    if (trimmed.isEmpty) return false;
    final exec = _resolveExecutor(txn);
    if (exec == null) return false;
    if (!await _hasTable(exec, 'guest_purged_tombstones')) {
      return false;
    }
    final rows = await exec.query(
      'guest_purged_tombstones',
      columns: const <String>['guest_profile_id'],
      where: 'guest_profile_id = ?',
      whereArgs: <Object?>[trimmed],
      limit: 1,
    );
    return rows.isNotEmpty;
  }

  /// Kiểm tra `guestProfileId` có đang bị cách ly (`QUARANTINED`) hay không.
  /// Bất biến ưu tiên: nếu ID đã nằm trong `guest_purged_tombstones`, luôn trả `false`
  /// (`PURGED` luôn thắng legacy backup/SharedPreferences conflict).
  Future<bool> isGuestScopeQuarantined(
    String profileId, {
    Transaction? txn,
  }) async {
    final trimmed = profileId.trim();
    if (trimmed.isEmpty) return false;

    if (await isGuestScopePurged(trimmed, txn: txn)) {
      return false;
    }

    final prefs = await _getPrefs();
    final exec = _resolveExecutor(txn);
    if (exec != null && await _hasTable(exec, 'guest_quarantined_scopes')) {
      final rows = await exec.query(
        'guest_quarantined_scopes',
        columns: const <String>['guest_profile_id'],
        where: 'guest_profile_id = ?',
        whereArgs: <Object?>[trimmed],
        limit: 1,
      );
      if (rows.isNotEmpty) {
        return true;
      }
      if (prefs.getBool(keyQuarantinedProfilesMigratedV6) == true) {
        return false;
      }
    }

    return _readCleanedLegacyQuarantinedPrefs(prefs).contains(trimmed);
  }

  /// Lấy hoặc tạo guestProfileId hiện hành.
  ///
  /// Tự động phục hồi sau crash: nếu `guestProfileId` đang lưu trên cache/Prefs đã mang
  /// terminal `PURGED` tombstone (ví dụ app crash sau khi commit `userClearedGuestData`
  /// trước lúc kịp xoay ID), hàm sẽ tự động xoay sang UUIDv4 mới tinh và lưu xuống Prefs.
  Future<String> getOrCreateGuestProfileId({Transaction? txn}) async {
    final prefs = await _getPrefs();
    final candidate = (_cachedProfileId != null && _cachedProfileId!.isNotEmpty)
        ? _cachedProfileId
        : prefs.getString(keyGuestProfileId);

    if (candidate != null && candidate.isNotEmpty) {
      final isPurged = await isGuestScopePurged(candidate, txn: txn);
      if (!isPurged) {
        _cachedProfileId = candidate;
        return candidate;
      }
      // Crash recovery: ID cũ đã PURGED -> tự động xoay sang ID mới tinh.
      return await rotateGuestProfileId(txn: txn);
    }

    final newProfileId = await _generateFreshEligibleGuestId(txn: txn);
    await prefs.setString(keyGuestProfileId, newProfileId);
    _cachedProfileId = newProfileId;
    return newProfileId;
  }

  /// Xoay guestProfileId sang UUIDv4 mới (sử dụng khi đăng xuất hoặc sau khi clear guest data).
  /// Trả về ID mới tinh để khởi tạo fresh guest scope.
  Future<String> rotateGuestProfileId({Transaction? txn}) async {
    final prefs = await _getPrefs();
    final newProfileId = await _generateFreshEligibleGuestId(txn: txn);
    await prefs.setString(keyGuestProfileId, newProfileId);
    _cachedProfileId = newProfileId;
    return newProfileId;
  }

  /// Chỉ xoay `guestProfileId` sang ID mới nếu ID hiện hành đúng bằng [expectedGuestProfileId].
  /// Ngăn chặn việc vô tình xoay nhầm active Guest khi dọn một detached Guest cũ.
  Future<String?> rotateGuestProfileIdIfMatching(
    String expectedGuestProfileId,
  ) async {
    final expected = expectedGuestProfileId.trim();
    if (expected.isEmpty) return null;
    final current = await peekGuestProfileId();
    if (current == expected) {
      return await rotateGuestProfileId();
    }
    return null;
  }

  /// Di trú idempotent một chiều danh sách quarantine legacy từ `SharedPreferences`
  /// sang SQLite v6 `guest_quarantined_scopes`.
  ///
  /// Invariant:
  /// - Làm sạch khoảng trắng thừa, bỏ qua chuỗi rỗng/trùng lặp.
  /// - **`PURGED` luôn thắng legacy `SharedPreferences`**: không bao giờ resurrect ID đã nằm
  ///   trong `guest_purged_tombstones`.
  /// - Chỉ đặt flag `migrated_v6 = true` **sau** khi SQLite transaction đã commit.
  /// - Giữ nguyên `keyQuarantinedProfiles` ở trạng thái read-only shadow (không ghi/xóa).
  Future<void> migrateLegacyQuarantinesToSqlite({
    @visibleForTesting Future<void> Function(Transaction txn)? onBeforeCommitHook,
    @visibleForTesting Future<void> Function()? onBeforeSetMigratedFlagHook,
  }) async {
    final prefs = await _getPrefs();
    if (prefs.getBool(keyQuarantinedProfilesMigratedV6) == true) {
      return;
    }

    final existingFlight = _inFlightMigration;
    if (existingFlight != null) {
      return await existingFlight;
    }

    final flight = () async {
      final dbManager = _offlineDatabase;
      if (dbManager == null || !dbManager.isInitialized) {
        return;
      }
      final db = dbManager.database;
      if (!await _hasV6LifecycleTables(db)) {
        return;
      }

      final cleanedIds = _readCleanedLegacyQuarantinedPrefs(prefs);
      await _runSqliteWriteTransaction<void>(db, (txn) async {
        final nowMs = DateTime.now().toUtc().millisecondsSinceEpoch;
        for (final id in cleanedIds) {
          await txn.rawInsert(
            '''
            INSERT OR IGNORE INTO guest_quarantined_scopes (
              guest_profile_id,
              quarantined_at_ms,
              source_user_id,
              reason
            )
            SELECT ?, ?, NULL, 'LEGACY_PREFS_MIGRATED'
            WHERE NOT EXISTS (
              SELECT 1 FROM guest_purged_tombstones WHERE guest_profile_id = ?
            );
            ''',
            <Object?>[id, nowMs, id],
          );
        }
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
      });

      if (onBeforeSetMigratedFlagHook != null) {
        await onBeforeSetMigratedFlagHook();
      }
      await prefs.setBool(keyQuarantinedProfilesMigratedV6, true);
    }();

    _inFlightMigration = flight;
    try {
      await flight;
    } finally {
      if (identical(_inFlightMigration, flight)) {
        _inFlightMigration = null;
      }
    }
  }

  /// Ghi nhận terminal `PURGED` tombstone cho [guestProfileId] bên trong [txn] SQLite hiện hành.
  Future<void> recordGuestPurgedTombstone({
    required Transaction txn,
    required String guestProfileId,
    required String purgeReason,
    String? purgedByUserId,
  }) async {
    final trimmed = guestProfileId.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError.value(
        guestProfileId,
        'guestProfileId',
        'guestProfileId must not be empty.',
      );
    }
    if (!await _hasTable(txn, 'guest_purged_tombstones')) {
      throw StateError(
        'SQLITE_V6_REQUIRED: Table guest_purged_tombstones is missing.',
      );
    }
    await txn.insert(
      'guest_purged_tombstones',
      <String, Object?>{
        'guest_profile_id': trimmed,
        'purged_at_ms': DateTime.now().toUtc().millisecondsSinceEpoch,
        'purge_reason': purgeReason,
        'purged_by_user_id': purgedByUserId,
      },
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
  }

  /// Đưa guestProfileId vào SQLite v6 SSoT `guest_quarantined_scopes` để bảo toàn dữ liệu
  /// (chống silent destruction và triệt tiêu đường ghi song song vào SharedPreferences).
  ///
  /// Fail-closed:
  /// - Ném [StateError] nếu chưa có SQLite v6 DB hoặc active [txn].
  /// - Ném [GuestLifecycleStateError] nếu `profileId` đã mang `PURGED` tombstone.
  Future<void> quarantineGuestScope(
    String profileId, {
    Transaction? txn,
    String? sourceUserId,
    String reason = 'SKIP_CLAIM',
    @visibleForTesting Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    if (profileId.isEmpty) return;
    final trimmed = profileId.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError.value(
        profileId,
        'profileId',
        'guestProfileId must not be whitespace-only.',
      );
    }

    Future<void> executeInTxn(Transaction t) async {
      if (!await _hasV6LifecycleTables(t)) {
        throw StateError(
          'SQLITE_V6_REQUIRED: Tables guest_quarantined_scopes and guest_purged_tombstones must exist before quarantining.',
        );
      }
      final purgedRows = await t.query(
        'guest_purged_tombstones',
        columns: const <String>['purge_reason'],
        where: 'guest_profile_id = ?',
        whereArgs: <Object?>[trimmed],
        limit: 1,
      );
      if (purgedRows.isNotEmpty) {
        throw GuestLifecycleStateError(
          'GUEST_ALREADY_PURGED: Cannot quarantine guestProfileId "$trimmed" because it is already PURGED (${purgedRows.first['purge_reason']}).',
        );
      }

      await t.insert(
        'guest_quarantined_scopes',
        <String, Object?>{
          'guest_profile_id': trimmed,
          'quarantined_at_ms': DateTime.now().toUtc().millisecondsSinceEpoch,
          'source_user_id': sourceUserId,
          'reason': reason,
        },
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );

      if (onBeforeCommitHook != null) {
        await onBeforeCommitHook(t);
      }
    }

    if (txn != null) {
      await executeInTxn(txn);
      return;
    }

    final dbManager = _offlineDatabase;
    if (dbManager == null || !dbManager.isInitialized) {
      throw StateError(
        'SQLITE_SSOT_REQUIRED: Cannot quarantineGuestScope("$trimmed") without an initialized OfflineDatabase v6 or active Transaction.',
      );
    }
    await _runSqliteWriteTransaction<void>(dbManager.database, executeInTxn);
  }

  /// Lấy danh sách các guest profile IDs đã được cách ly trên thiết bị này.
  /// Đọc trực tiếp từ SQLite SSoT `guest_quarantined_scopes` (tự chạy lazy migration hoặc
  /// hợp nhất trừ `guest_purged_tombstones` nếu chưa migrate xong).
  Future<List<String>> listQuarantinedGuestScopes({Transaction? txn}) async {
    final prefs = await _getPrefs();
    final dbManager = _offlineDatabase;
    if (txn == null &&
        dbManager != null &&
        dbManager.isInitialized &&
        prefs.getBool(keyQuarantinedProfilesMigratedV6) != true &&
        await _hasV6LifecycleTables(dbManager.database)) {
      await migrateLegacyQuarantinesToSqlite();
    }

    final exec = _resolveExecutor(txn);
    if (exec != null && await _hasV6LifecycleTables(exec)) {
      final rows = await exec.query(
        'guest_quarantined_scopes',
        columns: const <String>['guest_profile_id'],
        orderBy: 'quarantined_at_ms ASC, guest_profile_id ASC',
      );
      final resultSet = <String>{
        for (final r in rows)
          if (r['guest_profile_id'] is String &&
              (r['guest_profile_id'] as String).trim().isNotEmpty)
            (r['guest_profile_id'] as String).trim(),
      };

      if (prefs.getBool(keyQuarantinedProfilesMigratedV6) != true) {
        final purgedRows = await exec.query(
          'guest_purged_tombstones',
          columns: const <String>['guest_profile_id'],
        );
        final purgedSet = <String>{
          for (final r in purgedRows)
            if (r['guest_profile_id'] is String)
              (r['guest_profile_id'] as String).trim(),
        };
        for (final legacyId in _readCleanedLegacyQuarantinedPrefs(prefs)) {
          if (!purgedSet.contains(legacyId)) {
            resultSet.add(legacyId);
          }
        }
      }
      return resultSet.toList(growable: false);
    }

    return _readCleanedLegacyQuarantinedPrefs(prefs).toList(growable: false);
  }
}
