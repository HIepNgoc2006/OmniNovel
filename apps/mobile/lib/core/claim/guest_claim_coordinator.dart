import 'dart:convert';
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

  String? get currentUserId => _currentUserId;
  set currentUserId(String? val) => _currentUserId = val;

  String? get currentClaimId => _currentClaimId;
  set currentClaimId(String? val) => _currentClaimId = val;

  int? get activeGeneration => _activeGeneration;
  set activeGeneration(int? val) => _activeGeneration = val;

  GuestClaimPreviewResult? get previewData => _previewData;
  set previewData(GuestClaimPreviewResult? val) => _previewData = val;

  String? get error => _error;

  // ==================== TRIPLE-CHECK CONCURRENCY GUARD (P0-2) ====================

  /// Xác minh tính hợp lệ 4 chiều chống race condition:
  /// 1. `expectedGeneration == scopeBridge.transitionGeneration` (chống stale callback từ phiên trước).
  /// 2. `expectedUserId == authService.state.user?.id` (đúng user đang đăng nhập thực tế).
  /// 3. `authService.state.isAuthenticated == true` (user không ở trạng thái logout).
  /// 4. Nếu truyền `expectedClaimId`, phải khớp `_currentClaimId`.
  bool isSessionValid({
    required int expectedGeneration,
    required String expectedUserId,
    String? expectedClaimId,
  }) {
    final currentGen = _scopeBridge.transitionGeneration;
    final currentUser = _authService.state.user?.id;
    final isAuthenticated = _authService.state.isAuthenticated;

    if (currentGen != expectedGeneration) return false;
    if (!isAuthenticated || currentUser != expectedUserId) return false;
    if (_currentUserId != null && _currentUserId != expectedUserId) return false;
    if (expectedClaimId != null && expectedClaimId != _currentClaimId) return false;
    return true;
  }

  // ==================== PREPARE CLAIM ====================

  /// Kiểm tra dữ liệu khách và chuẩn bị claim khi người dùng vừa đăng nhập.
  Future<void> checkAndPrepareClaim(String userId) async {
    final capturedGen = _scopeBridge.transitionGeneration;
    final capturedUserId = userId;

    if (!isSessionValid(expectedGeneration: capturedGen, expectedUserId: capturedUserId)) {
      return;
    }

    _isPreparing = true;
    _error = null;
    _isPendingUnavailable = false;
    notifyListeners();

    try {
      final guestProfileId = await _guestProvider.getOrCreateGuestProfileId();
      final guestScope = 'guest:$guestProfileId';

      final hasData = await _dao.hasGuestData(guestScope);

      if (!hasData) {
        _isPreparing = false;
        notifyListeners();

        // Triple-check guard trước khi resolve
        if (!isSessionValid(expectedGeneration: capturedGen, expectedUserId: capturedUserId)) {
          return;
        }

        await _scopeBridge.resolveToAccount(userId, expectedGeneration: capturedGen);
        return;
      }

      // Khách có dữ liệu -> Dispatch POST /prepare
      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.guestClaimPrepare,
        data: {'guestProfileId': guestProfileId},
      );

      final data = response.data;
      if (data == null) {
        throw StateError('Invalid empty response from prepare claim API');
      }

      final preview = GuestClaimPreviewResult.fromJson(data);

      // Post-network Triple-Check Guard: Nếu user đã logout hoặc generation thay đổi, bỏ qua ngay
      if (!isSessionValid(expectedGeneration: capturedGen, expectedUserId: capturedUserId)) {
        _isPreparing = false;
        return;
      }

      // Invariant: Lập tức ghi PendingGuestClaim(phase: prepared) vào SQLite journal TRƯỚC KHI mở modal
      final now = DateTime.now().millisecondsSinceEpoch;
      await _offlineDb.database.insert(
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
        conflictAlgorithm: ConflictAlgorithm.replace,
      );

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
    final guestProfileId = await _guestProvider.getOrCreateGuestProfileId();

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
      final prepRes = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.guestClaimPrepare,
        data: {'guestProfileId': guestProfileId},
      );

      final newPreview = GuestClaimPreviewResult.fromJson(prepRes.data!);

      if (!isSessionValid(expectedGeneration: capturedGen, expectedUserId: userId)) {
        _isCommitting = false;
        return;
      }

      final now = DateTime.now().millisecondsSinceEpoch;
      // Xóa claim cũ bị conflict và thay thế bằng claim mới
      if (_currentClaimId != null) {
        await _offlineDb.database.delete(
          'guest_claim_recovery_journal',
          where: 'claim_id = ?',
          whereArgs: [_currentClaimId],
        );
      }

      await _offlineDb.database.insert(
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

  /// Người dùng chủ động bỏ qua claim: Cách ly partition khách, xóa journal và mở account.
  Future<void> skipClaim(String userId) async {
    // Guard 1: Đang trong quá trình commit -> tuyệt đối không cho skip
    if (_isCommitting) {
      throw StateError('Cannot skip claim once commit has started');
    }

    // Guard 2: Kiểm tra journal trong SQLite, nếu đã ở 'committing' hoặc 'committedServer' -> cấm skip
    if (_currentClaimId != null) {
      final journalRows = await _offlineDb.database.query(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: [_currentClaimId],
        limit: 1,
      );
      if (journalRows.isNotEmpty) {
        final phase = journalRows.first['phase'] as String?;
        if (phase == 'committing' || phase == 'committedServer') {
          throw StateError('Cannot skip claim once commit has started');
        }
      }
    }

    final capturedGen = _activeGeneration ?? _scopeBridge.transitionGeneration;
    if (!isSessionValid(expectedGeneration: capturedGen, expectedUserId: userId)) {
      _isOpen = false;
      return;
    }

    // 1. Lưu marker cách ly vào SharedPreferences
    final guestProfileId = await _guestProvider.getOrCreateGuestProfileId();
    await _guestProvider.quarantineGuestScope(guestProfileId);

    // 2. Xóa bản ghi recovery journal
    if (_currentClaimId != null) {
      await _offlineDb.database.delete(
        'guest_claim_recovery_journal',
        where: 'claim_id = ? AND user_id = ?',
        whereArgs: [_currentClaimId, userId],
      );
    }

    // Invariant: Partition SQLite của khách được bảo toàn 100%

    // 3. Đóng dialog và mở account
    _isOpen = false;
    _currentUserId = null;
    _currentClaimId = null;
    _activeGeneration = null;
    _previewData = null;
    notifyListeners();

    await _scopeBridge.resolveToAccount(userId, expectedGeneration: capturedGen);
  }

  // ==================== CRASH RECOVERY MATRIX ====================

  /// Phục hồi sự cố khi ứng dụng khởi động lại hoặc mở lại app.
  Future<void> checkCrashRecovery(String userId) async {
    final rows = await _offlineDb.database.query(
      'guest_claim_recovery_journal',
      where: 'user_id = ?',
      whereArgs: [userId],
      limit: 1,
    );

    if (rows.isEmpty) return;

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
          }
        } catch (e) {
          _isPendingUnavailable = true;
          _error = e.toString();
          notifyListeners();
          _scopeBridge.markPendingUnavailable(_error!);
        }
        break;

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
          } else if (statusResult.status == GuestClaimStatus.prepared) {
            // Server vẫn ở prepared -> mở lại modal
            _currentUserId = userId;
            _currentClaimId = claimId;
            _activeGeneration = capturedGen;
            _previewData = statusResult.previewData;
            _isOpen = true;
            notifyListeners();
          }
        } catch (e) {
          _isPendingUnavailable = true;
          _error = e.toString();
          notifyListeners();
          _scopeBridge.markPendingUnavailable(_error!);
        }
        break;

      case 'prepared':
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
        break;
    }
  }
}
