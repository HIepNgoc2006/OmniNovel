import 'dart:convert';
import 'dart:math' as math;
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';
import '../api/api_client.dart';
import '../api/api_endpoints.dart';
import '../auth/auth_service.dart';
import '../identity/guest_profile_identity_provider.dart';
import '../storage/local_library_dao.dart';
import '../storage/offline_database.dart';
import 'models/guest_claim_models.dart';
import 'models/pending_guest_claim.dart';
export 'models/pending_guest_claim.dart' show CrashRecoveryResult;
import 'scope_coordinator_claim_bridge.dart';

/// Coordinator quản lý toàn bộ vòng đời Chuyển Giao Dữ Liệu Khách sang Tài Khoản
/// (Guest-to-Account Data Claim Orchestrator & Durable Crash Recovery Engine).
///
/// Tuân thủ nghiêm ngặt:
/// 1. Triple-Check Concurrency Guard: Xác minh đồng thời transitionGeneration, AuthService user ID,
///    và trạng thái isAuthenticated trước bất kỳ thay đổi UI, journal, scope hoặc finalization.
/// 2. Durable 3-Phase SQLite Ledger: Mọi bước chuyển đổi trạng thái ('prepared', 'committing', 'committedServer')
///    đều được ghi nhận bền vững vào `guest_claim_recovery_journal` trước khi dispatch network request.
/// 3. P0-1 Commited-Only Destructive Finalization: Tuyệt đối không xóa partition khách hay journal
///    khi chưa có xác nhận COMMITTED từ server và journal chưa chuyển bền vững sang 'committedServer'.
/// 4. Non-destructive Skip & Legacy Fallback: Bảo toàn 100% dữ liệu khách khi người dùng chọn Bỏ qua
///    hoặc server cũ trả finalization == null.
class GuestClaimCoordinator extends ChangeNotifier {
  final LocalLibraryDao _dao;
  final ScopeCoordinatorClaimBridge _scopeBridge;
  final GuestProfileIdentityProvider _guestProvider;
  final ApiClient _apiClient;
  final OfflineDatabase _offlineDb;
  final AuthService _authService;
  final SharedPreferences _prefs;
  static const Duration _defaultBusyRetryTimeout = Duration(milliseconds: 5000);

  bool _isOpen = false;
  bool _isPreparing = false;
  bool _isCommitting = false;
  bool _isPendingUnavailable = false;

  String? _currentUserId;
  String? _currentClaimId;
  int? _activeGeneration;
  GuestClaimPreviewResult? _previewData;
  String? _error;

  GuestClaimCoordinator({
    required LocalLibraryDao dao,
    required ScopeCoordinatorClaimBridge scopeBridge,
    required GuestProfileIdentityProvider guestProvider,
    required ApiClient apiClient,
    required OfflineDatabase offlineDb,
    required AuthService authService,
    required SharedPreferences prefs,
  })  : _dao = dao,
        _scopeBridge = scopeBridge,
        _guestProvider = guestProvider,
        _apiClient = apiClient,
        _offlineDb = offlineDb,
        _authService = authService,
        _prefs = prefs;

  // ==================== GETTERS & VISIBLE-FOR-TESTING SETTERS ====================

  bool get isOpen => _isOpen;
  set isOpen(bool val) {
    _isOpen = val;
    notifyListeners();
  }

  bool get isPreparing => _isPreparing;
  bool get isCommitting => _isCommitting;
  bool get isPendingUnavailable => _isPendingUnavailable;
  SharedPreferences get prefs => _prefs;

  String? get currentUserId => _currentUserId;
  set currentUserId(String? val) => _currentUserId = val;

  String? get currentClaimId => _currentClaimId;
  set currentClaimId(String? val) => _currentClaimId = val;

  int? get activeGeneration => _activeGeneration;
  set activeGeneration(int? val) => _activeGeneration = val;

  int? get activeOperationId => _activeOperationId;
  set activeOperationId(int? val) => _activeOperationId = val;

  GuestClaimPreviewResult? get previewData => _previewData;
  set previewData(GuestClaimPreviewResult? val) => _previewData = val;

  String? get error => _error;

  int _prepareRequestId = 0;
  int? _activeOperationId;

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
    Future<T> Function(Transaction txn) action,
  ) async {
    final stopwatch = Stopwatch()..start();
    var attempt = 0;

    while (true) {
      var enteredAction = false;
      try {
        return await _offlineDb.database.transaction<T>((txn) async {
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

  /// Đặt lại toàn bộ phiên claim khi đăng xuất hoặc hủy phiên (P0-2)
  void resetSession() {
    _isOpen = false;
    _isPreparing = false;
    _isCommitting = false;
    _currentUserId = null;
    _currentClaimId = null;
    _activeGeneration = null;
    _activeOperationId = null;
    _previewData = null;
    _error = null;
    _isPendingUnavailable = false;
    notifyListeners();
  }

  // ==================== TRIPLE-CHECK CONCURRENCY GUARD (P0-2) ====================

  /// Xác minh tính hợp lệ 5 chiều chống race condition:
  /// 1. `expectedGeneration == scopeBridge.transitionGeneration` (chống stale callback từ phiên trước).
  /// 2. `expectedUserId == authService.state.user?.id` (đúng user đang đăng nhập thực tế).
  /// 3. `authService.state.isAuthenticated == true` (user không ở trạng thái logout).
  /// 4. So sánh nghiêm ngặt: `_currentUserId == expectedUserId` (khi _currentUserId bị reset về null hoặc mismatch, lập tức từ chối).
  /// 5. Nếu truyền `expectedClaimId`, phải khớp `_currentClaimId`.
  /// 6. Nếu truyền `expectedOperationId`, phải khớp `_activeOperationId`.
  bool isSessionValid({
    required int expectedGeneration,
    required String expectedUserId,
    String? expectedClaimId,
    int? expectedOperationId,
  }) {
    final currentGen = _scopeBridge.transitionGeneration;
    final currentUser = _authService.state.user?.id;
    final isAuthenticated = _authService.state.isAuthenticated;

    if (currentGen != expectedGeneration) return false;
    if (!isAuthenticated || currentUser != expectedUserId) return false;
    if (_currentUserId != expectedUserId) return false;
    if (expectedClaimId != null && expectedClaimId != _currentClaimId) return false;
    if (expectedOperationId != null && expectedOperationId != _activeOperationId) return false;
    return true;
  }

  // ==================== PREPARE CLAIM ====================

  /// Kiểm tra dữ liệu khách và chuẩn bị claim khi người dùng vừa đăng nhập.
  Future<void> checkAndPrepareClaim(String userId) async {
    final capturedGen = _scopeBridge.transitionGeneration;
    final capturedUserId = userId;
    final opId = ++_prepareRequestId;
    _activeOperationId = opId;
    _currentUserId = userId;

    if (!isSessionValid(
      expectedGeneration: capturedGen,
      expectedUserId: capturedUserId,
      expectedOperationId: opId,
    )) {
      return;
    }

    _isPreparing = true;
    _error = null;
    _isPendingUnavailable = false;
    notifyListeners();

    // Invariant P0-2: Nếu đã có journal pending của user này trong SQLite, cấm tạo prepare mới!
    final existingRows = await _offlineDb.database.query(
      'guest_claim_recovery_journal',
      where: 'user_id = ?',
      whereArgs: [userId],
      limit: 1,
    );
    if (existingRows.isNotEmpty) {
      _isPreparing = false;
      notifyListeners();
      return;
    }

    try {
      await _guestProvider.migrateLegacyQuarantinesToSqlite();

      // Pre-HTTP Lifecycle Eligibility Guard (SQLite v6 SSoT):
      // Tuyệt đối không gọi POST /prepare nếu guestProfileId đã mang terminal PURGED tombstone
      // hoặc đã bị QUARANTINED; giải phóng transition sang Account để không kẹt luồng đăng nhập.
      final peekedGuestId = await _guestProvider.peekGuestProfileId();
      if (peekedGuestId != null && peekedGuestId.isNotEmpty) {
        if (await _guestProvider.isGuestScopePurged(peekedGuestId)) {
          _isPreparing = false;
          _isOpen = false;
          _isPendingUnavailable = false;
          _error =
              'GUEST_ALREADY_PURGED: Guest "$peekedGuestId" has been purged and cannot be claimed.';
          notifyListeners();
          if (isSessionValid(
            expectedGeneration: capturedGen,
            expectedUserId: capturedUserId,
            expectedOperationId: opId,
          )) {
            await _scopeBridge.resolveToAccount(
              userId,
              expectedGeneration: capturedGen,
            );
          }
          return;
        }
        if (await _guestProvider.isGuestScopeQuarantined(peekedGuestId)) {
          _isPreparing = false;
          _isOpen = false;
          _isPendingUnavailable = false;
          _error =
              'GUEST_QUARANTINED: Guest "$peekedGuestId" is quarantined and cannot be auto-claimed.';
          notifyListeners();
          if (isSessionValid(
            expectedGeneration: capturedGen,
            expectedUserId: capturedUserId,
            expectedOperationId: opId,
          )) {
            await _scopeBridge.resolveToAccount(
              userId,
              expectedGeneration: capturedGen,
            );
          }
          return;
        }
      }

      final guestProfileId =
          peekedGuestId ?? await _guestProvider.getOrCreateGuestProfileId();
      final guestScope = 'guest:$guestProfileId';

      final hasData = await _dao.hasGuestData(guestScope);

      if (!hasData) {
        _isPreparing = false;
        notifyListeners();

        // Triple-check guard trước khi resolve
        if (!isSessionValid(
          expectedGeneration: capturedGen,
          expectedUserId: capturedUserId,
          expectedOperationId: opId,
        )) {
          return;
        }

        await _scopeBridge.resolveToAccount(userId, expectedGeneration: capturedGen);
        return;
      }

      // Khách có dữ liệu -> Dispatch POST /prepare (KHÔNG giữ SQLite lock qua HTTP!)
      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.guestClaimPrepare,
        data: {'guestProfileId': guestProfileId},
      );

      final data = response.data;
      if (data == null) {
        throw StateError('Invalid empty response from prepare claim API');
      }

      final preview = GuestClaimPreviewResult.fromJson(data);

      // Post-network Triple-Check Guard: Nếu user đã logout, gen thay đổi, session reset, hoặc có request prepare mới hơn
      if (!isSessionValid(
        expectedGeneration: capturedGen,
        expectedUserId: capturedUserId,
        expectedOperationId: opId,
      )) {
        _isPreparing = false;
        return;
      }

      // Post-HTTP Eligibility Recheck & Atomic Journal Write (KHÔNG giữ SQLite lock trong HTTP):
      // Kiểm tra lại bên trong SQLite transaction trước khi ghi journal `prepared` để chặn
      // mọi `PURGED` hoặc `QUARANTINED` xảy ra xen kẽ trong lúc chờ HTTP POST /prepare.
      final outcome = await _runSqliteWriteTransaction<_PrepareJournalOutcome>(
        (txn) async {
          if (!isSessionValid(
            expectedGeneration: capturedGen,
            expectedUserId: capturedUserId,
            expectedOperationId: opId,
          )) {
            return _PrepareJournalOutcome.sessionInvalid;
          }

          final concurrentJournal = await txn.query(
            'guest_claim_recovery_journal',
            columns: const <String>['claim_id'],
            where: 'user_id = ?',
            whereArgs: <Object?>[userId],
            limit: 1,
          );
          if (concurrentJournal.isNotEmpty) {
            return _PrepareJournalOutcome.alreadyExists;
          }

          if (await _guestProvider.isGuestScopePurged(
            guestProfileId,
            txn: txn,
          )) {
            return _PrepareJournalOutcome.rejectedPurged;
          }

          if (await _guestProvider.isGuestScopeQuarantined(
            guestProfileId,
            txn: txn,
          )) {
            return _PrepareJournalOutcome.rejectedQuarantined;
          }

          final now = DateTime.now().millisecondsSinceEpoch;
          await txn.insert(
            'guest_claim_recovery_journal',
            {
              'claim_id': preview.claimId,
              'user_id': userId,
              'guest_profile_id': guestProfileId,
              'expected_state_fingerprint': preview.stateFingerprint,
              'conflict_decisions': '{}',
              'phase': 'prepared',
              'preview_data': jsonEncode(preview.toJson()),
              'created_at': now,
              'updated_at': now,
            },
            conflictAlgorithm: ConflictAlgorithm.abort,
          );
          return _PrepareJournalOutcome.inserted;
        },
      );

      if (outcome == _PrepareJournalOutcome.rejectedPurged) {
        _isPreparing = false;
        _isOpen = false;
        _isPendingUnavailable = false;
        _error =
            'GUEST_ALREADY_PURGED: Guest "$guestProfileId" was purged during prepare and journal creation was blocked.';
        notifyListeners();
        if (isSessionValid(
          expectedGeneration: capturedGen,
          expectedUserId: capturedUserId,
          expectedOperationId: opId,
        )) {
          await _scopeBridge.resolveToAccount(
            userId,
            expectedGeneration: capturedGen,
          );
        }
        return;
      }

      if (outcome == _PrepareJournalOutcome.rejectedQuarantined) {
        _isPreparing = false;
        _isOpen = false;
        _isPendingUnavailable = false;
        _error =
            'GUEST_QUARANTINED: Guest "$guestProfileId" was quarantined during prepare and journal creation was blocked.';
        notifyListeners();
        if (isSessionValid(
          expectedGeneration: capturedGen,
          expectedUserId: capturedUserId,
          expectedOperationId: opId,
        )) {
          await _scopeBridge.resolveToAccount(
            userId,
            expectedGeneration: capturedGen,
          );
        }
        return;
      }

      if (outcome != _PrepareJournalOutcome.inserted) {
        _isPreparing = false;
        notifyListeners();
        return;
      }

      _currentUserId = userId;
      _currentClaimId = preview.claimId;
      _activeGeneration = capturedGen;
      _previewData = preview;
      _isOpen = true;
      _isPreparing = false;
      notifyListeners();
    } catch (e) {
      _isPreparing = false;
      _error = e.toString();
      _isPendingUnavailable = true;
      notifyListeners();
      _scopeBridge.markPendingUnavailable(_error!);
    }
  }

  // ==================== CONFIRM CLAIM ====================

  /// Xác nhận chuyển giao dữ liệu với các quyết định xử lý xung đột của người dùng.
  Future<void> confirmClaim(
    String userId,
    Map<String, ConflictResolution> conflictDecisions,
  ) async {
    final capturedGen = _activeGeneration ?? _scopeBridge.transitionGeneration;

    if (!isSessionValid(
      expectedGeneration: capturedGen,
      expectedUserId: userId,
      expectedClaimId: _currentClaimId,
    )) {
      return;
    }

    if (_currentClaimId == null || _previewData == null) {
      throw StateError('No active claim to confirm');
    }

    final claimId = _currentClaimId!;
    String? journalGuestProfileId;
    final journalRowsForClaim = await _offlineDb.database.query(
      'guest_claim_recovery_journal',
      columns: const <String>['guest_profile_id'],
      where: 'claim_id = ? AND user_id = ?',
      whereArgs: <Object?>[claimId, userId],
      limit: 1,
    );
    if (journalRowsForClaim.isNotEmpty) {
      journalGuestProfileId =
          journalRowsForClaim.first['guest_profile_id'] as String?;
    }
    final guestProfileId = (journalGuestProfileId != null &&
            journalGuestProfileId.isNotEmpty)
        ? journalGuestProfileId
        : (await _guestProvider.peekGuestProfileId() ??
            await _guestProvider.getOrCreateGuestProfileId());

    _isCommitting = true;
    _error = null;
    notifyListeners();

    // Checkpoint bền vững: Ghi nhận phase 'committing' vào SQLite journal TRƯỚC KHI gửi HTTP
    final now = DateTime.now().millisecondsSinceEpoch;
    final decisionsMap = conflictDecisions.map((k, v) => MapEntry(k, v.value));
    await _offlineDb.database.update(
      'guest_claim_recovery_journal',
      {
        'phase': 'committing',
        'conflict_decisions': jsonEncode(decisionsMap),
        'updated_at': now,
      },
      where: 'claim_id = ? AND user_id = ?',
      whereArgs: [claimId, userId],
    );

    try {
      final payload = CommitGuestClaimPayload.validated(
        expectedStateFingerprint: _previewData!.stateFingerprint,
        conflictDecisions: conflictDecisions,
      );

      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.guestClaimCommit(claimId),
        data: payload.toJson(),
      );

      final data = response.data;
      if (data == null) {
        throw StateError('Invalid empty response from commit claim API');
      }

      final commitResult = GuestClaimCommitResult.fromJson(data);

      await _processCommitResult(
        userId: userId,
        claimId: claimId,
        guestProfileId: guestProfileId,
        capturedGen: capturedGen,
        commitResult: commitResult,
      );
    } on DioException catch (e) {
      if (e.response?.statusCode == 409) {
        // 409 Conflict: State fingerprint thay đổi -> tự động re-prepare và làm mới preview
        await _handle409Conflict(userId, guestProfileId, capturedGen);
      } else {
        // Lỗi kết nối / timeout: kiểm tra xem server thực tế đã COMMITTED chưa qua GET /status
        await _handleCommitError(userId, claimId, guestProfileId, capturedGen, e);
      }
    } catch (e) {
      _isCommitting = false;
      _error = e.toString();
      _isPendingUnavailable = true;
      notifyListeners();
      _scopeBridge.markPendingUnavailable(_error!);
    }
  }

  /// Xử lý kết quả trả về khi Server đã phản hồi commit thành công.
  Future<void> _processCommitResult({
    required String userId,
    required String claimId,
    required String guestProfileId,
    required int capturedGen,
    required GuestClaimCommitResult commitResult,
  }) async {
    // 1. Triple-Check Guard ngay từ đầu (TRƯỚC KHI THỰC HIỆN BẤT KỲ CẬP NHẬT SQLITE / JOURNAL NÀO)
    if (!isSessionValid(
      expectedGeneration: capturedGen,
      expectedUserId: userId,
      expectedClaimId: claimId,
    )) {
      _isCommitting = false;
      return;
    }

    // Trường hợp server không trả finalization data (legacy server)
    if (commitResult.finalization == null) {
      // Rebind non-destructive bookmarks, bảo toàn 100% partition khách và giữ nguyên journal
      await _dao.rebindScope(
        sourceScope: 'guest:$guestProfileId',
        targetScope: 'account:$userId',
        claimId: claimId,
        finalization: null,
      );

      _isCommitting = false;
      _error = 'Legacy server commit completed without authoritative finalization snapshot';
      _isPendingUnavailable = true;
      notifyListeners();
      _scopeBridge.markPendingUnavailable(_error!);
      return;
    }

    // P0-1 Invariant: Chuyển phase sang 'committedServer' TRƯỚC KHI thực hiện destructive rebind
    final now = DateTime.now().millisecondsSinceEpoch;
    await _offlineDb.database.update(
      'guest_claim_recovery_journal',
      {
        'phase': 'committedServer',
        'updated_at': now,
      },
      where: 'claim_id = ? AND user_id = ?',
      whereArgs: [claimId, userId],
    );

    // Rebind authoritative + purge guest partition + xóa journal trong cùng một SQLite Transaction nguyên tử
    await _dao.rebindScope(
      sourceScope: 'guest:$guestProfileId',
      targetScope: 'account:$userId',
      claimId: claimId,
      finalization: commitResult.finalization,
    );

    // Triple-check guard trước khi thay đổi UI và resolve scope
    if (!isSessionValid(
      expectedGeneration: capturedGen,
      expectedUserId: userId,
      expectedClaimId: claimId,
    )) {
      _isCommitting = false;
      _isOpen = false;
      return;
    }

    _isOpen = false;
    _isCommitting = false;
    _currentUserId = null;
    _currentClaimId = null;
    _activeGeneration = null;
    _activeOperationId = null;
    _previewData = null;
    notifyListeners();

    await _scopeBridge.resolveToAccount(userId, expectedGeneration: capturedGen);
  }

  /// Xử lý ngoại lệ mạng khi commit: Thử query GET /status để phục hồi nếu server đã kịp commit.
  Future<void> _handleCommitError(
    String userId,
    String claimId,
    String guestProfileId,
    int capturedGen,
    dynamic error,
  ) async {
    try {
      final statusRes = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.guestClaimStatus(claimId),
      );
      final statusData = statusRes.data;
      if (statusData != null) {
        final statusResult = GuestClaimStatusResult.fromJson(statusData);
        if (statusResult.status == GuestClaimStatus.committed &&
            statusResult.finalization != null) {
          // Server thực tế ĐÃ COMMITTED! Phục hồi hoàn chỉnh:
          await _processCommitResult(
            userId: userId,
            claimId: claimId,
            guestProfileId: guestProfileId,
            capturedGen: capturedGen,
            commitResult: GuestClaimCommitResult(
              claimId: claimId,
              status: GuestClaimStatus.committed,
              committedAt: statusResult.committedAt ?? DateTime.now().toIso8601String(),
              summary: statusResult.resultSummary ??
                  const GuestClaimCommitSummary(
                    bookmarksImported: 0,
                    historyMerged: 0,
                    progressUpdated: 0,
                    conflictsResolved: 0,
                  ),
              finalization: statusResult.finalization,
            ),
          );
          return;
        }
      }
    } catch (_) {
      // GET /status cũng lỗi mạng -> giữ nguyên journal 'committing' để crash recovery xử lý sau
    }

    _isCommitting = false;
    _error = error.toString();
    _isPendingUnavailable = true;
    notifyListeners();
    _scopeBridge.markPendingUnavailable(_error!);
  }

  /// Xử lý 409 Conflict: State fingerprint không còn khớp, tự động re-prepare và làm mới preview.
  Future<void> _handle409Conflict(
    String userId,
    String guestProfileId,
    int capturedGen,
  ) async {
    try {
      if (await _guestProvider.isGuestScopePurged(guestProfileId)) {
        _isCommitting = false;
        _isOpen = false;
        _error =
            'GUEST_ALREADY_PURGED: Cannot re-prepare conflict claim for purged guest "$guestProfileId".';
        notifyListeners();
        return;
      }

      final prepRes = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.guestClaimPrepare,
        data: {'guestProfileId': guestProfileId},
      );

      final newPreview = GuestClaimPreviewResult.fromJson(prepRes.data!);

      if (!isSessionValid(expectedGeneration: capturedGen, expectedUserId: userId)) {
        _isCommitting = false;
        return;
      }

      final swapped = await _runSqliteWriteTransaction<bool>((txn) async {
        if (await _guestProvider.isGuestScopePurged(guestProfileId, txn: txn) ||
            await _guestProvider.isGuestScopeQuarantined(
              guestProfileId,
              txn: txn,
            )) {
          return false;
        }

        final now = DateTime.now().millisecondsSinceEpoch;
        if (_currentClaimId != null) {
          await txn.delete(
            'guest_claim_recovery_journal',
            where: 'claim_id = ?',
            whereArgs: [_currentClaimId],
          );
        }

        await txn.insert(
          'guest_claim_recovery_journal',
          {
            'claim_id': newPreview.claimId,
            'user_id': userId,
            'guest_profile_id': guestProfileId,
            'expected_state_fingerprint': newPreview.stateFingerprint,
            'conflict_decisions': '{}',
            'phase': 'prepared',
            'preview_data': jsonEncode(newPreview.toJson()),
            'created_at': now,
            'updated_at': now,
          },
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
        return true;
      });

      if (!swapped) {
        _isCommitting = false;
        _isOpen = false;
        _error =
            'GUEST_ALREADY_PURGED: Guest "$guestProfileId" became ineligible during 409 re-prepare.';
        notifyListeners();
        return;
      }

      _currentClaimId = newPreview.claimId;
      _previewData = newPreview;
      _isCommitting = false;
      notifyListeners();
    } catch (e) {
      _isCommitting = false;
      _error = 'Conflict recovery failed: $e';
      _isPendingUnavailable = true;
      notifyListeners();
      _scopeBridge.markPendingUnavailable(_error!);
    }
  }

  // ==================== SKIP CLAIM ====================

  /// Người dùng chủ động bỏ qua claim: Cách ly partition khách trong SQLite v6 SSoT
  /// (`guest_quarantined_scopes`), xóa journal và mở account trong **1 SQLite transaction nguyên tử**.
  ///
  /// - Kiểm tra terminal `PURGED` tombstone bên trong transaction trước khi insert quarantine
  ///   (`purge-before-quarantine` => rollback + ném [GuestLifecycleStateError]).
  /// - Bảo vệ crash-safe: rollback hoàn toàn nếu lỗi xảy ra trước `COMMIT`
  ///   (ví dụ crash giữa INSERT quarantine và DELETE journal).
  Future<void> skipClaim(
    String userId, {
    @visibleForTesting Future<void> Function(Transaction txn)?
        onAfterQuarantineBeforeJournalDeleteHook,
    @visibleForTesting Future<void> Function(Transaction txn)?
        onBeforeCommitHook,
  }) async {
    // Guard 1: Đang trong quá trình commit -> tuyệt đối không cho skip
    if (_isCommitting) {
      throw StateError('Cannot skip claim once commit has started');
    }

    final capturedGen = _activeGeneration ?? _scopeBridge.transitionGeneration;
    if (!isSessionValid(expectedGeneration: capturedGen, expectedUserId: userId)) {
      _isOpen = false;
      return;
    }

    final fallbackGuestId = await _guestProvider.peekGuestProfileId();

    final committed = await _runSqliteWriteTransaction<bool>((txn) async {
      // Guard 2: Kiểm tra journal trong SQLite TRONG transaction:
      // nếu đã ở 'committing' hoặc 'committedServer' -> cấm skip
      String? journalGuestId;
      if (_currentClaimId != null) {
        final journalRows = await txn.query(
          'guest_claim_recovery_journal',
          columns: const <String>['phase', 'guest_profile_id'],
          where: 'claim_id = ?',
          whereArgs: [_currentClaimId],
          limit: 1,
        );
        if (journalRows.isNotEmpty) {
          final phase = journalRows.first['phase'] as String?;
          if (phase == 'committing' || phase == 'committedServer') {
            throw StateError('Cannot skip claim once commit has started');
          }
          journalGuestId = journalRows.first['guest_profile_id'] as String?;
        }
      }

      if (!isSessionValid(expectedGeneration: capturedGen, expectedUserId: userId)) {
        return false;
      }

      final guestProfileId = (journalGuestId != null && journalGuestId.isNotEmpty)
          ? journalGuestId
          : (fallbackGuestId ??
              await _guestProvider.getOrCreateGuestProfileId(txn: txn));

      // 1. Ghi quarantine vào SQLite SSoT (kiểm tra NOT PURGED bên trong cùng txn ->
      // nếu Guest đã bị purge trước đó, ném GuestLifecycleStateError & rollback transaction)
      await _guestProvider.quarantineGuestScope(
        guestProfileId,
        txn: txn,
        sourceUserId: userId,
        reason: 'SKIP_CLAIM',
      );

      if (onAfterQuarantineBeforeJournalDeleteHook != null) {
        await onAfterQuarantineBeforeJournalDeleteHook(txn);
      }

      // 2. Xóa bản ghi recovery journal trong cùng SQLite transaction nguyên tử
      if (_currentClaimId != null) {
        await txn.delete(
          'guest_claim_recovery_journal',
          where: 'claim_id = ? AND user_id = ?',
          whereArgs: [_currentClaimId, userId],
        );
      }

      if (onBeforeCommitHook != null) {
        await onBeforeCommitHook(txn);
      }

      return true;
    });

    if (!committed) {
      _isOpen = false;
      notifyListeners();
      return;
    }

    // Invariant: Partition SQLite của khách được bảo toàn 100%

    // 3. Chỉ đóng dialog và mở account SAU KHI SQLite transaction đã commit bền vững
    _isOpen = false;
    _currentUserId = null;
    _currentClaimId = null;
    _activeGeneration = null;
    _activeOperationId = null;
    _previewData = null;
    notifyListeners();

    await _scopeBridge.resolveToAccount(userId, expectedGeneration: capturedGen);
  }

  // ==================== CRASH RECOVERY MATRIX ====================

  /// Phục hồi sự cố khi ứng dụng khởi động lại hoặc mở lại app.
  Future<CrashRecoveryResult> checkCrashRecovery(String userId) async {
    _currentUserId = userId;
    final rows = await _offlineDb.database.query(
      'guest_claim_recovery_journal',
      where: 'user_id = ?',
      whereArgs: [userId],
      limit: 1,
    );

    if (rows.isEmpty) {
      final anyRows = await _offlineDb.database.query(
        'guest_claim_recovery_journal',
        limit: 1,
      );
      if (anyRows.isNotEmpty) {
        return CrashRecoveryResult.blockedByOtherUser;
      }
      return CrashRecoveryResult.noPending;
    }

    final row = rows.first;
    final claimId = row['claim_id'] as String;
    final guestProfileId = row['guest_profile_id'] as String;
    final phase = row['phase'] as String;
    final previewJsonStr = row['preview_data'] as String?;

    final capturedGen = _scopeBridge.transitionGeneration;

    switch (phase) {
      case 'committedServer':
        // Server đã commit trước khi crash -> Query /status và hoàn tất rebind
        try {
          final statusRes = await _apiClient.get<Map<String, dynamic>>(
            ApiEndpoints.guestClaimStatus(claimId),
          );
          final statusResult = GuestClaimStatusResult.fromJson(statusRes.data!);
          if (statusResult.finalization != null) {
            await _dao.rebindScope(
              sourceScope: 'guest:$guestProfileId',
              targetScope: 'account:$userId',
              claimId: claimId,
              finalization: statusResult.finalization,
            );

            if (isSessionValid(expectedGeneration: capturedGen, expectedUserId: userId)) {
              await _scopeBridge.resolveToAccount(userId, expectedGeneration: capturedGen);
            }
            return CrashRecoveryResult.finalized;
          }
          return CrashRecoveryResult.pendingUnavailable;
        } catch (e) {
          _isPendingUnavailable = true;
          _error = e.toString();
          notifyListeners();
          _scopeBridge.markPendingUnavailable(_error!);
          return CrashRecoveryResult.pendingUnavailable;
        }

      case 'committing':
        // Crash trong lúc gửi commit -> Query GET /status kiểm tra kết quả
        try {
          final statusRes = await _apiClient.get<Map<String, dynamic>>(
            ApiEndpoints.guestClaimStatus(claimId),
          );
          final statusResult = GuestClaimStatusResult.fromJson(statusRes.data!);

          if (statusResult.status == GuestClaimStatus.committed &&
              statusResult.finalization != null) {
            // Server đã commit xong -> chuyển phase sang committedServer và rebind
            await _offlineDb.database.update(
              'guest_claim_recovery_journal',
              {
                'phase': 'committedServer',
                'updated_at': DateTime.now().millisecondsSinceEpoch,
              },
              where: 'claim_id = ?',
              whereArgs: [claimId],
            );

            await _dao.rebindScope(
              sourceScope: 'guest:$guestProfileId',
              targetScope: 'account:$userId',
              claimId: claimId,
              finalization: statusResult.finalization,
            );

            if (isSessionValid(expectedGeneration: capturedGen, expectedUserId: userId)) {
              await _scopeBridge.resolveToAccount(userId, expectedGeneration: capturedGen);
            }
            return CrashRecoveryResult.finalized;
          } else if (statusResult.status == GuestClaimStatus.prepared) {
            // Server vẫn ở prepared -> mở lại modal
            _currentUserId = userId;
            _currentClaimId = claimId;
            _activeGeneration = capturedGen;
            _previewData = statusResult.previewData;
            _isOpen = true;
            notifyListeners();
            return CrashRecoveryResult.userActionRequired;
          }
          return CrashRecoveryResult.pendingUnavailable;
        } catch (e) {
          _isPendingUnavailable = true;
          _error = e.toString();
          notifyListeners();
          _scopeBridge.markPendingUnavailable(_error!);
          return CrashRecoveryResult.pendingUnavailable;
        }

      case 'prepared':
        // Stage 1B Lifecycle Guard: Nếu Guest đã mang terminal PURGED tombstone trong khi
        // còn sót journal `prepared` mồ côi -> dọn journal fail-closed, KHÔNG mở modal rỗng.
        if (await _guestProvider.isGuestScopePurged(guestProfileId)) {
          await _runSqliteWriteTransaction<void>((txn) async {
            if (await _guestProvider.isGuestScopePurged(
              guestProfileId,
              txn: txn,
            )) {
              await txn.delete(
                'guest_claim_recovery_journal',
                where: 'claim_id = ? AND user_id = ? AND phase = ?',
                whereArgs: <Object?>[claimId, userId, 'prepared'],
              );
            }
          });
          _isOpen = false;
          _previewData = null;
          notifyListeners();
          return CrashRecoveryResult.noPending;
        }
        // Crash khi modal đang mở -> khôi phục previewData từ journal và mở lại modal
        if (previewJsonStr != null && previewJsonStr.isNotEmpty) {
          try {
            final previewMap = jsonDecode(previewJsonStr) as Map<String, dynamic>;
            _previewData = GuestClaimPreviewResult.fromJson(previewMap);
          } catch (_) {}
        }
        _currentUserId = userId;
        _currentClaimId = claimId;
        _activeGeneration = capturedGen;
        _isOpen = true;
        notifyListeners();
        return CrashRecoveryResult.userActionRequired;
    }
    return CrashRecoveryResult.noPending;
  }
}

enum _PrepareJournalOutcome {
  inserted,
  alreadyExists,
  rejectedPurged,
  rejectedQuarantined,
  sessionInvalid,
}
