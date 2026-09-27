import 'package:flutter/foundation.dart';

/// Ngoại lệ ném ra khi có yêu cầu xóa một chương truyện đang được mở đọc bởi ít nhất một phiên Reader.
class ChapterInUseException implements Exception {
  final String userId;
  final String chapterVersionId;
  final String message;

  const ChapterInUseException({
    required this.userId,
    required this.chapterVersionId,
    this.message = 'Không thể xóa chương truyện vì đang được sử dụng trong phiên đọc active.',
  });

  @override
  String toString() =>
      'ChapterInUseException: $message (userId: $userId, chapterVersionId: $chapterVersionId)';
}

/// Ngoại lệ ném ra khi có yêu cầu mở/lease một chương truyện đang trong quá trình xóa (Process-Local Deletion Reservation).
class ChapterDeletingException implements Exception {
  final String userId;
  final String chapterVersionId;
  final String message;

  const ChapterDeletingException({
    required this.userId,
    required this.chapterVersionId,
    this.message = 'Chương truyện đang trong quá trình xóa, không thể truy cập hoặc mở phiên đọc.',
  });

  @override
  String toString() =>
      'ChapterDeletingException: $message (userId: $userId, chapterVersionId: $chapterVersionId)';
}

/// Token đại diện cho quyền giữ khóa xóa độc quyền (Process-Local Deletion Reservation) trong RAM.
/// Bảo vệ tài nguyên khỏi race condition giữa Reader lease và Deletion service.
@immutable
class DeletionReservationToken {
  final String userId;
  final String chapterVersionId;
  final String reservationId;

  const DeletionReservationToken({
    required this.userId,
    required this.chapterVersionId,
    required this.reservationId,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DeletionReservationToken &&
          runtimeType == other.runtimeType &&
          reservationId == other.reservationId;

  @override
  int get hashCode => reservationId.hashCode;

  @override
  String toString() =>
      'DeletionReservationToken(reservationId: $reservationId, userId: $userId, chapterVersionId: $chapterVersionId)';
}

/// Token đại diện cho một phiên đọc đang hoạt động (Active Reader Lease).
/// Bảo vệ chapter không bị bộ dọn dẹp (Quota/Eviction/Manual Deletion) xóa trong khi đang đọc.
@immutable
class ReaderLeaseToken {
  final String userId;
  final String chapterVersionId;
  final String readerSessionId;
  final String leaseId;
  final int acquiredAt;

  const ReaderLeaseToken({
    required this.userId,
    required this.chapterVersionId,
    required this.readerSessionId,
    required this.leaseId,
    required this.acquiredAt,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ReaderLeaseToken &&
          runtimeType == other.runtimeType &&
          leaseId == other.leaseId;

  @override
  int get hashCode => leaseId.hashCode;

  @override
  String toString() =>
      'ReaderLeaseToken(leaseId: $leaseId, userId: $userId, chapterVersionId: $chapterVersionId, readerSessionId: $readerSessionId)';
}

/// Trình quản lý Active Reader Leases (In-Memory Reference Counting) & Deletion Reservations.
///
/// **Các Bất Biến Cốt Lõi (Invariants):**
/// 1. **Process-Local Only**: Leases và Deletion Reservations chỉ sống trong RAM của tiến trình; không bao giờ persist vào SQLite.
///    Nếu ứng dụng bị kill, các lease và reservation tự động biến mất và không cản trở việc dọn dẹp khi khởi động lại.
/// 2. **Multi-Reader Ref-Count**: Nếu có nhiều reader/session cùng mở một `chapterVersionId`,
///    mỗi phiên nhận một token riêng với `leaseId` độc lập. Ref-count > 1.
/// 3. **Isolated Release**: Việc release token của phiên A không ảnh hưởng tới token của phiên B.
/// 4. **Idempotent Release**: Gọi `releaseLease()` nhiều lần với cùng một token là an toàn (trả về `false` ở lần sau).
/// 5. **User Scoped**: Phân tách rõ ràng giữa các user, không bao giờ nhầm lẫn lease giữa các user khác nhau.
/// 6. **Race-Free Deletion Reservation**: Khóa độc quyền trong RAM khi tiến trình xóa bắt đầu; chặn đứng mọi Reader acquire lease đồng thời.
class ReaderLeaseManager {
  int _nonce = 0;
  final Map<String, ReaderLeaseToken> _tokensById = {};
  final Map<String, Set<String>> _leasesByVersion = {}; // key: "userId:chapterVersionId" -> Set<leaseId>
  final Set<String> _deletingVersions = {}; // key: "userId:chapterVersionId"

  String _versionKey(String userId, String chapterVersionId) => '$userId:$chapterVersionId';

  /// Đăng ký một phiên đọc đang giữ tài nguyên chapter.
  /// Ném [ChapterDeletingException] nếu chương đang trong tiến trình xóa (Deletion Reservation).
  ReaderLeaseToken acquireLease({
    required String userId,
    required String chapterVersionId,
    required String readerSessionId,
  }) {
    if (userId.trim().isEmpty) {
      throw ArgumentError('userId cannot be empty or blank');
    }
    if (chapterVersionId.trim().isEmpty) {
      throw ArgumentError('chapterVersionId cannot be empty or blank');
    }
    if (readerSessionId.trim().isEmpty) {
      throw ArgumentError('readerSessionId cannot be empty or blank');
    }

    final key = _versionKey(userId, chapterVersionId);
    if (_deletingVersions.contains(key)) {
      throw ChapterDeletingException(
        userId: userId,
        chapterVersionId: chapterVersionId,
      );
    }

    final nowMicros = DateTime.now().microsecondsSinceEpoch;
    _nonce++;
    final leaseId = 'lease_${userId}_${chapterVersionId}_${readerSessionId}_${nowMicros}_$_nonce';

    final token = ReaderLeaseToken(
      userId: userId,
      chapterVersionId: chapterVersionId,
      readerSessionId: readerSessionId,
      leaseId: leaseId,
      acquiredAt: DateTime.now().millisecondsSinceEpoch,
    );

    _tokensById[leaseId] = token;

    _leasesByVersion.putIfAbsent(key, () => <String>{}).add(leaseId);

    return token;
  }

  /// Trả tự do cho lease token khi phiên đọc kết thúc hoặc đóng reader.
  /// Thao tác này có tính idempotent: nếu token đã được giải phóng trước đó thì trả về false.
  bool releaseLease(ReaderLeaseToken? token) {
    if (token == null) return false;
    final existing = _tokensById.remove(token.leaseId);
    if (existing == null) {
      return false; // Đã giải phóng hoặc token không hợp lệ
    }

    final key = _versionKey(existing.userId, existing.chapterVersionId);
    final versionSet = _leasesByVersion[key];
    if (versionSet != null) {
      versionSet.remove(token.leaseId);
      if (versionSet.isEmpty) {
        _leasesByVersion.remove(key);
      }
    }

    return true;
  }

  /// Kiểm tra xem chapter có đang được giữ bởi ít nhất một phiên đọc hay không.
  bool isLeased(String userId, String chapterVersionId) {
    final key = _versionKey(userId, chapterVersionId);
    return _leasesByVersion[key]?.isNotEmpty ?? false;
  }

  /// Lấy số lượng reader session đang giữ chapter.
  int getActiveLeaseCount(String userId, String chapterVersionId) {
    final key = _versionKey(userId, chapterVersionId);
    return _leasesByVersion[key]?.length ?? 0;
  }

  /// Lấy danh sách tất cả các token đang active của một người dùng.
  List<ReaderLeaseToken> getActiveTokensForUser(String userId) {
    return _tokensById.values.where((t) => t.userId == userId).toList(growable: false);
  }

  /// Kiểm tra xem chapterVersionId có đang được giữ trong tiến trình xóa hay không.
  bool isDeleting(String userId, String chapterVersionId) {
    return _deletingVersions.contains(_versionKey(userId, chapterVersionId));
  }

  /// Đặt trước quyền xóa (Deletion Reservation) đơn lẻ trong RAM một cách nguyên tử.
  /// Ném [ChapterInUseException] nếu chương đang có ít nhất một active Reader lease.
  /// Ném [ChapterDeletingException] nếu chương đang được giữ bởi một tiến trình xóa khác.
  DeletionReservationToken reserveDeletion({
    required String userId,
    required String chapterVersionId,
  }) {
    if (userId.trim().isEmpty) {
      throw ArgumentError('userId cannot be empty or blank');
    }
    if (chapterVersionId.trim().isEmpty) {
      throw ArgumentError('chapterVersionId cannot be empty or blank');
    }

    final key = _versionKey(userId, chapterVersionId);
    if (isLeased(userId, chapterVersionId)) {
      throw ChapterInUseException(
        userId: userId,
        chapterVersionId: chapterVersionId,
      );
    }
    if (_deletingVersions.contains(key)) {
      throw ChapterDeletingException(
        userId: userId,
        chapterVersionId: chapterVersionId,
        message: 'Chương truyện đã được đặt trước để xóa bởi một tiến trình khác.',
      );
    }

    _deletingVersions.add(key);
    _nonce++;
    final resId = 'del_res_${userId}_${chapterVersionId}_${DateTime.now().microsecondsSinceEpoch}_$_nonce';
    return DeletionReservationToken(
      userId: userId,
      chapterVersionId: chapterVersionId,
      reservationId: resId,
    );
  }

  /// Đặt trước quyền xóa hàng loạt (Batch Deletion Reservation) theo nguyên tắc All-or-Nothing trong RAM.
  /// Nếu có BẤT KỲ chương nào đang leased hoặc đang deleting, lập tức ném ngoại lệ và không giữ bất kỳ chương nào.
  List<DeletionReservationToken> reserveDeletionBatch({
    required String userId,
    required List<String> chapterVersionIds,
  }) {
    if (userId.trim().isEmpty) {
      throw ArgumentError('userId cannot be empty or blank');
    }

    // 1. Kiểm tra All-or-Nothing check trước khi mutate state
    for (final vId in chapterVersionIds) {
      if (isLeased(userId, vId)) {
        throw ChapterInUseException(
          userId: userId,
          chapterVersionId: vId,
          message: 'Không thể xóa batch vì chương $vId đang được đọc trong một phiên Reader active.',
        );
      }
      if (isDeleting(userId, vId)) {
        throw ChapterDeletingException(
          userId: userId,
          chapterVersionId: vId,
          message: 'Không thể xóa batch vì chương $vId đang được xóa bởi tiến trình khác.',
        );
      }
    }

    // 2. Atomic reservation
    final tokens = <DeletionReservationToken>[];
    final nowMicros = DateTime.now().microsecondsSinceEpoch;
    for (final vId in chapterVersionIds) {
      final key = _versionKey(userId, vId);
      _deletingVersions.add(key);
      _nonce++;
      tokens.add(DeletionReservationToken(
        userId: userId,
        chapterVersionId: vId,
        reservationId: 'del_res_${userId}_${vId}_${nowMicros}_$_nonce',
      ));
    }
    return tokens;
  }

  /// Giải phóng reservation xóa đơn lẻ.
  void releaseDeletionReservation(DeletionReservationToken? token) {
    if (token == null) return;
    _deletingVersions.remove(_versionKey(token.userId, token.chapterVersionId));
  }

  /// Giải phóng danh sách reservation xóa hàng loạt.
  void releaseDeletionReservationBatch(List<DeletionReservationToken>? tokens) {
    if (tokens == null) return;
    for (final token in tokens) {
      _deletingVersions.remove(_versionKey(token.userId, token.chapterVersionId));
    }
  }

  /// Xóa sạch mọi lease và reservation trong bộ nhớ (phục vụ testing hoặc reset hoàn toàn).
  void clearAll() {
    _tokensById.clear();
    _leasesByVersion.clear();
    _deletingVersions.clear();
  }
}
