/// Mô hình đại diện cho Deletion Tombstone trong giao thức xóa 3 bước (3-Step Deletion Protocol).
/// Đảm bảo tính nhất quán giữa SQLite và OS Filesystem khi xảy ra sự cố (Crash Recovery).
/// Invariant: UNIQUE(user_id, chapter_version_id) ngăn chặn duplicate deletion tombstone.
class OfflineDeletionTombstone {
  final String tombstoneId;
  final String userId;
  final String chapterVersionId;
  final int createdAt; // epoch ms

  const OfflineDeletionTombstone({
    required this.tombstoneId,
    required this.userId,
    required this.chapterVersionId,
    required this.createdAt,
  });

  OfflineDeletionTombstone copyWith({
    String? tombstoneId,
    String? userId,
    String? chapterVersionId,
    int? createdAt,
  }) {
    return OfflineDeletionTombstone(
      tombstoneId: tombstoneId ?? this.tombstoneId,
      userId: userId ?? this.userId,
      chapterVersionId: chapterVersionId ?? this.chapterVersionId,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'tombstone_id': tombstoneId,
      'user_id': userId,
      'chapter_version_id': chapterVersionId,
      'created_at': createdAt,
    };
  }

  factory OfflineDeletionTombstone.fromMap(Map<String, dynamic> map) {
    return OfflineDeletionTombstone(
      tombstoneId: map['tombstone_id'] as String,
      userId: map['user_id'] as String,
      chapterVersionId: map['chapter_version_id'] as String,
      createdAt: (map['created_at'] as num).toInt(),
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is OfflineDeletionTombstone &&
        other.tombstoneId == tombstoneId &&
        other.userId == userId &&
        other.chapterVersionId == chapterVersionId &&
        other.createdAt == createdAt;
  }

  @override
  int get hashCode => Object.hash(tombstoneId, userId, chapterVersionId, createdAt);

  @override
  String toString() {
    return 'OfflineDeletionTombstone(id: $tombstoneId, user: $userId, version: $chapterVersionId, createdAt: $createdAt)';
  }
}
