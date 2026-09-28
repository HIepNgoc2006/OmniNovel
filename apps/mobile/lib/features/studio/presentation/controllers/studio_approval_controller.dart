import 'package:flutter/foundation.dart';
import '../../../../core/errors/api_error.dart';
import '../../../../core/utils/uuid_generator.dart';
import '../../models/studio_models.dart';
import '../../repositories/studio_repository.dart';

enum StudioApprovalStatus {
  idle,
  submitting,
  submissionOutcomeUnknown,
  reconciling,
  succeeded,
  committedReconciliationRequired,
  failed,
}

class StudioApprovalController extends ChangeNotifier {
  final StudioRepository _repository;
  TranslationJobReviewDetailResponse _jobDetail;
  final int initialWorkspaceRevision;

  StudioApprovalStatus _status = StudioApprovalStatus.idle;
  ApplyTranslationMode? _selectedMode;
  String? _frozenIdempotencyKey;
  ApplyTranslationMode? _frozenMode;
  String? _errorMessage;
  ApplyTranslationJobResponse? _applyResponse;

  StudioApprovalController({
    required StudioRepository repository,
    required TranslationJobReviewDetailResponse initialJobDetail,
  })  : _repository = repository,
        _jobDetail = initialJobDetail,
        initialWorkspaceRevision = initialJobDetail.job.workspaceRevision;

  // Getters
  TranslationJobReviewDetailResponse get jobDetail => _jobDetail;
  StudioApprovalStatus get status => _status;
  ApplyTranslationMode? get selectedMode => _selectedMode;
  String? get frozenIdempotencyKey => _frozenIdempotencyKey;
  ApplyTranslationMode? get frozenMode => _frozenMode;
  String? get errorMessage => _errorMessage;
  ApplyTranslationJobResponse? get applyResponse => _applyResponse;

  bool get isFresh => _jobDetail.isFresh;

  /// Gate 4 & 5 Hardening:
  /// CTA chỉ được kích hoạt khi:
  /// 1. job.status == READY_FOR_REVIEW
  /// 2. permissions.canApply == true
  /// 3. permissions.applyBlockReason == null
  /// 4. isFresh == true (reviewRevision == materializedRevision)
  /// 5. selectedMode != null (explicit choice)
  /// 6. status == idle (not currently in-flight)
  bool get isApplyEnabled {
    return _jobDetail.job.status == TranslationJobStatus.readyForReview &&
        _jobDetail.permissions.canApply &&
        _jobDetail.permissions.applyBlockReason == null &&
        _jobDetail.isFresh &&
        _selectedMode != null &&
        _status == StudioApprovalStatus.idle;
  }

  bool get canSelectMode =>
      _status == StudioApprovalStatus.idle || _frozenMode == null;

  bool get canRetryAmbiguous =>
      _status == StudioApprovalStatus.submissionOutcomeUnknown;

  /// Chọn chế độ xuất bản (Explicit Mode Selection - Gate 5)
  void selectMode(ApplyTranslationMode mode) {
    if (!canSelectMode) return;
    _selectedMode = mode;
    notifyListeners();
  }

  /// Kích hoạt gửi lệnh Apply/Publish (Gate 4, 5, 6)
  Future<void> submitApply({String? testIdempotencyKey}) async {
    // Fail-Closed Gate 4: Tuyệt đối không gửi request nếu chưa thỏa mãn freshness & permissions
    if (!isApplyEnabled) return;

    _status = StudioApprovalStatus.submitting;
    _errorMessage = null;

    // Freeze identity pair {key, mode} (Gate 6)
    _frozenIdempotencyKey = testIdempotencyKey ?? generateUuidV4();
    _frozenMode = _selectedMode!;
    notifyListeners();

    try {
      final res = await _repository.applyJob(
        _jobDetail.job.id,
        ApplyTranslationJobRequest(mode: _frozenMode!),
        idempotencyKey: _frozenIdempotencyKey!,
      );

      _applyResponse = res;
      // Authoritative Post-Apply Coherence Check (Gate 7)
      await _reconcileInternal(knownResponse: res);
    } catch (e) {
      if (_isNetworkAmbiguity(e)) {
        // Chuyển sang SUBMISSION_OUTCOME_UNKNOWN khi gặp timeout / lỗi kết nối
        _status = StudioApprovalStatus.submissionOutcomeUnknown;
        _errorMessage = 'Kết nối mạng gián đoạn trong lúc gửi lệnh xuất bản. Vui lòng tiến hành đối soát kết quả.';
      } else {
        _status = StudioApprovalStatus.failed;
        if (e is ApiError && e.statusCode == 409) {
          _errorMessage = 'Bản dịch đã bị thay đổi trên server (Artifact Stale). Vui lòng làm mới.';
        } else if (e is ApiError) {
          _errorMessage = e.message;
        } else {
          _errorMessage = e.toString();
        }
      }
      notifyListeners();
    }
  }

  /// Gọi đối soát có thẩm quyền với máy chủ (Reconciliation - Gate 6 & 7)
  Future<void> reconcile() async {
    if (_status != StudioApprovalStatus.submissionOutcomeUnknown &&
        _status != StudioApprovalStatus.submitting) {
      return;
    }
    await _reconcileInternal(knownResponse: _applyResponse);
  }

  Future<void> _reconcileInternal({ApplyTranslationJobResponse? knownResponse}) async {
    _status = StudioApprovalStatus.reconciling;
    notifyListeners();

    try {
      final newDetail = await _repository.getJobDetail(_jobDetail.job.id);
      _jobDetail = newDetail;

      if (newDetail.job.status == TranslationJobStatus.applied) {
        // Coherence verification (Gate 7):
        // 1. targetVersion.id khớp với apply response
        // 2. workspaceRevision đã tăng tiến
        final bool targetVersionCoherent = knownResponse != null
            ? (newDetail.context.targetVersion?.id == knownResponse.targetVersionId)
            : (newDetail.context.targetVersion != null);

        final bool revisionCoherent =
            newDetail.job.workspaceRevision > initialWorkspaceRevision;

        if (targetVersionCoherent && revisionCoherent) {
          _status = StudioApprovalStatus.succeeded;
          _errorMessage = null;
        } else {
          _status = StudioApprovalStatus.committedReconciliationRequired;
          _errorMessage =
              'Đã ghi nhận xuất bản trên máy chủ nhưng phát hiện sai lệch tính nhất quán phiên bản (Coherence Mismatch).';
        }
      } else if (newDetail.job.status == TranslationJobStatus.readyForReview) {
        // Bằng chứng có thẩm quyền xác nhận apply CHƯA commit trên máy chủ (Gate 6)
        // Cho phép giải phóng frozen identity và người dùng có thể đổi mode / thử lại
        _frozenIdempotencyKey = null;
        _frozenMode = null;
        _status = StudioApprovalStatus.idle;
        _errorMessage =
            'Bản dịch chưa được áp dụng trên server. Bạn có thể thay đổi tùy chọn và thử lại.';
      } else if (newDetail.job.status == TranslationJobStatus.canceled ||
          newDetail.job.status == TranslationJobStatus.failed ||
          newDetail.job.status == TranslationJobStatus.expired) {
        _status = StudioApprovalStatus.failed;
        _errorMessage =
            'Job dịch đã kết thúc với trạng thái: ${newDetail.job.status.toServerString()}.';
      } else {
        _status = StudioApprovalStatus.failed;
        _errorMessage =
            'Trạng thái job không hợp lệ sau khi đối soát: ${newDetail.job.status.toServerString()}.';
      }
    } catch (e) {
      if (_isNetworkAmbiguity(e)) {
        // Gate 6: Nếu GET đối soát tiếp tục gặp timeout / lỗi mạng, giữ nguyên OUTCOME_UNKNOWN (tuyệt đối không FAILED)
        _status = StudioApprovalStatus.submissionOutcomeUnknown;
        _errorMessage = 'Không thể kết nối đến máy chủ để đối soát. Vui lòng thử lại sau.';
      } else {
        _status = StudioApprovalStatus.failed;
        _errorMessage = e is ApiError ? e.message : e.toString();
      }
    }

    notifyListeners();
  }

  bool _isNetworkAmbiguity(dynamic error) {
    if (error is ApiError) {
      return error.code == 'NETWORK_ERROR' ||
          error.code == 'TIMEOUT' ||
          error.statusCode == 502 ||
          error.statusCode == 504;
    }
    final msg = error.toString().toLowerCase();
    return msg.contains('timeout') ||
        msg.contains('socketexception') ||
        msg.contains('connection refused') ||
        msg.contains('network');
  }
}
