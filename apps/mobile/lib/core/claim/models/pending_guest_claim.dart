import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';

/// Các pha quan sát được của tiến trình Claim dữ liệu Khách (Crash Recovery State Machine).
///
/// Bền vững trong SQLite journal 9 cột `guest_claim_recovery_journal`:
/// - `prepared`: Đã gọi POST /prepare thành công, lưu snapshot preview trước khi mở modal BottomSheet.
/// - `committing`: Người dùng đã xác nhận claim, lưu conflictDecisions trước khi gửi POST /commit.
/// - `committedServer`: Server đã trả về 200 COMMITTED, chuẩn bị thực hiện rebindScope nguyên tử.
enum ClaimRecoveryPhase {
  prepared,
  committing,
  committedServer;

  static ClaimRecoveryPhase fromString(String? val) {
    if (val == null) return ClaimRecoveryPhase.prepared;
    final trimmed = val.trim();
    for (final phase in ClaimRecoveryPhase.values) {
      if (phase.name == trimmed) return phase;
    }
    return ClaimRecoveryPhase.prepared;
  }
}

/// Model Bản ghi Nhật ký Phục hồi Claim Khách (Guest Claim Recovery Journal).
///
/// Quản lý trạng thái bền vững trong bảng SQLite `guest_claim_recovery_journal` gồm đúng 9 cột:
/// 1. `claim_id TEXT PRIMARY KEY`
/// 2. `user_id TEXT NOT NULL`
/// 3. `guest_profile_id TEXT NOT NULL`
/// 4. `expected_state_fingerprint TEXT NOT NULL`
/// 5. `conflict_decisions TEXT NOT NULL` (JSON-encoded map)
/// 6. `phase TEXT NOT NULL`
/// 7. `preview_data TEXT` (JSON string)
/// 8. `created_at INTEGER NOT NULL` (millisecondsSinceEpoch)
/// 9. `updated_at INTEGER NOT NULL` (millisecondsSinceEpoch)
@immutable
class PendingGuestClaim {
  final String claimId;
  final String userId;
  final String guestProfileId;
  final String expectedStateFingerprint;
  final Map<String, ConflictResolution> conflictDecisions;
  final ClaimRecoveryPhase phase;
  final String? previewDataJson;
  final DateTime createdAt;
  final DateTime updatedAt;

  const PendingGuestClaim({
    required this.claimId,
    required this.userId,
    required this.guestProfileId,
    required this.expectedStateFingerprint,
    this.conflictDecisions = const {},
    required this.phase,
    this.previewDataJson,
    required this.createdAt,
    required this.updatedAt,
  });

  /// Chuyển đổi sang Map để insert/update vào bảng SQLite `guest_claim_recovery_journal` (9 cột).
  Map<String, dynamic> toMap() => {
        'claim_id': claimId,
        'user_id': userId,
        'guest_profile_id': guestProfileId,
        'expected_state_fingerprint': expectedStateFingerprint,
        'conflict_decisions': jsonEncode(
          conflictDecisions.map((k, v) => MapEntry(k, v.value)),
        ),
        'phase': phase.name,
        'preview_data': previewDataJson,
        'created_at': createdAt.millisecondsSinceEpoch,
        'updated_at': updatedAt.millisecondsSinceEpoch,
      };

  /// Khôi phục từ bản ghi SQLite 9 cột.
  factory PendingGuestClaim.fromMap(Map<String, dynamic> map) {
    Map<String, ConflictResolution> decisions = {};
    final rawDecisions = map['conflict_decisions'];
    if (rawDecisions is String && rawDecisions.isNotEmpty) {
      try {
        final decoded = jsonDecode(rawDecisions) as Map<String, dynamic>;
        decisions = decoded.map(
          (k, v) => MapEntry(k, ConflictResolution.fromString(v?.toString())),
        );
      } catch (_) {}
    } else if (rawDecisions is Map<String, dynamic>) {
      decisions = rawDecisions.map(
        (k, v) => MapEntry(k, ConflictResolution.fromString(v?.toString())),
      );
    }

    final rawPhase = map['phase'] as String? ?? 'prepared';
    final phase = ClaimRecoveryPhase.values.firstWhere(
      (p) => p.name == rawPhase,
      orElse: () => ClaimRecoveryPhase.prepared,
    );

    return PendingGuestClaim(
      claimId: map['claim_id'] as String,
      userId: map['user_id'] as String,
      guestProfileId: map['guest_profile_id'] as String,
      expectedStateFingerprint:
          map['expected_state_fingerprint'] as String? ?? '',
      conflictDecisions: decisions,
      phase: phase,
      previewDataJson: map['preview_data'] as String?,
      createdAt: DateTime.fromMillisecondsSinceEpoch(
        map['created_at'] as int,
        isUtc: true,
      ),
      updatedAt: DateTime.fromMillisecondsSinceEpoch(
        map['updated_at'] as int,
        isUtc: true,
      ),
    );
  }

  /// Tạo bản sao có cập nhật một số trường (ví dụ chuyển phase hoặc cập nhật decisions).
  PendingGuestClaim copyWith({
    String? claimId,
    String? userId,
    String? guestProfileId,
    String? expectedStateFingerprint,
    Map<String, ConflictResolution>? conflictDecisions,
    ClaimRecoveryPhase? phase,
    String? previewDataJson,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return PendingGuestClaim(
      claimId: claimId ?? this.claimId,
      userId: userId ?? this.userId,
      guestProfileId: guestProfileId ?? this.guestProfileId,
      expectedStateFingerprint:
          expectedStateFingerprint ?? this.expectedStateFingerprint,
      conflictDecisions: conflictDecisions ?? this.conflictDecisions,
      phase: phase ?? this.phase,
      previewDataJson: previewDataJson ?? this.previewDataJson,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PendingGuestClaim &&
          runtimeType == other.runtimeType &&
          claimId == other.claimId &&
          userId == other.userId &&
          guestProfileId == other.guestProfileId &&
          expectedStateFingerprint == other.expectedStateFingerprint &&
          mapEquals(conflictDecisions, other.conflictDecisions) &&
          phase == other.phase &&
          previewDataJson == other.previewDataJson &&
          createdAt.millisecondsSinceEpoch ==
              other.createdAt.millisecondsSinceEpoch &&
          updatedAt.millisecondsSinceEpoch ==
              other.updatedAt.millisecondsSinceEpoch;

  @override
  int get hashCode => Object.hash(
        claimId,
        userId,
        guestProfileId,
        expectedStateFingerprint,
        Object.hashAll(conflictDecisions.entries),
        phase,
        previewDataJson,
        createdAt.millisecondsSinceEpoch,
        updatedAt.millisecondsSinceEpoch,
      );
}
