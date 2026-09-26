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

/// Trình quản lý Active Reader Leases (In-Memory Reference Counting).
///
/// **Các Bất Biến Cốt Lõi (Invariants):**
/// 1. **Process-Local Only**: Leases chỉ sống trong RAM của tiến trình; không bao giờ persist vào SQLite.
///    Nếu ứng dụng bị kill, các lease tự động biến mất và không cản trở việc dọn dẹp khi khởi động lại.
/// 2. **Multi-Reader Ref-Count**: Nếu có nhiều reader/session cùng mở một `chapterVersionId`,
///    mỗi phiên nhận một token riêng với `leaseId` độc lập. Ref-count > 1.
/// 3. **Isolated Release**: Việc release token của phiên A không ảnh hưởng tới token của phiên B.
/// 4. **Idempotent Release**: Gọi `releaseLease()` nhiều lần với cùng một token là an toàn (trả về `false` ở lần sau).
/// 5. **User Scoped**: Phân tách rõ ràng giữa các user, không bao giờ nhầm lẫn lease giữa các user khác nhau.
class ReaderLeaseManager {
  int _nonce = 0;
  final Map<String, ReaderLeaseToken> _tokensById = {};
  final Map<String, Set<String>> _leasesByVersion = {}; // key: "userId:chapterVersionId" -> Set<leaseId>

  String _versionKey(String userId, String chapterVersionId) => '$userId:$chapterVersionId';

  /// Đăng ký một phiên đọc đang giữ tài nguyên chapter.
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

    final key = _versionKey(userId, chapterVersionId);
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

  /// Xóa sạch mọi lease trong bộ nhớ (phục vụ testing hoặc reset hoàn toàn).
  void clearAll() {
    _tokensById.clear();
    _leasesByVersion.clear();
  }
}
