/// Mô hình biểu diễn một chương truyện đã được xác thực và cài đặt thành công ngoại tuyến.
/// LƯU Ý P0.6: Mô hình này KHÔNG CÓ trường `status`. Sự tồn tại của bản ghi trong CSDL
/// chính là bằng chứng xác thực duy nhất (Canonical Proof / SSoT) rằng chương có thể đọc offline.
class OfflineChapter {
  final String userId;
  final String chapterVersionId;
  final String chapterId;
  final String storyId;
  final String storyTitle;
  final String chapterNumber;
  final String? chapterTitle;
  final String mediaFormat; // 'COMIC' | 'NOVEL'
  final String? publicationFormat; // 'WEBTOON' | 'PAGED_MANGA'
  final String installedDir; // Đường dẫn tương đối trong App-Private storage
  final int totalFiles;
  final int totalBytes;
  final int installedAt; // epoch ms
  final int? lastReadAt; // epoch ms
  final String manifestJson; // Backup raw manifest json string
  final bool isPinned;

  const OfflineChapter({
    this.userId = 'default_user',
    required this.chapterVersionId,
    required this.chapterId,
    required this.storyId,
    required this.storyTitle,
    required this.chapterNumber,
    this.chapterTitle,
    required this.mediaFormat,
    this.publicationFormat,
    required this.installedDir,
    required this.totalFiles,
    required this.totalBytes,
    required this.installedAt,
    this.lastReadAt,
    required this.manifestJson,
    this.isPinned = false,
  });

  OfflineChapter copyWith({
    String? userId,
    String? chapterVersionId,
    String? chapterId,
    String? storyId,
    String? storyTitle,
    String? chapterNumber,
    String? chapterTitle,
    String? mediaFormat,
    String? publicationFormat,
    String? installedDir,
    int? totalFiles,
    int? totalBytes,
    int? installedAt,
    int? lastReadAt,
    String? manifestJson,
    bool? isPinned,
  }) {
    return OfflineChapter(
      userId: userId ?? this.userId,
      chapterVersionId: chapterVersionId ?? this.chapterVersionId,
      chapterId: chapterId ?? this.chapterId,
      storyId: storyId ?? this.storyId,
      storyTitle: storyTitle ?? this.storyTitle,
      chapterNumber: chapterNumber ?? this.chapterNumber,
      chapterTitle: chapterTitle ?? this.chapterTitle,
      mediaFormat: mediaFormat ?? this.mediaFormat,
      publicationFormat: publicationFormat ?? this.publicationFormat,
      installedDir: installedDir ?? this.installedDir,
      totalFiles: totalFiles ?? this.totalFiles,
      totalBytes: totalBytes ?? this.totalBytes,
      installedAt: installedAt ?? this.installedAt,
      lastReadAt: lastReadAt ?? this.lastReadAt,
      manifestJson: manifestJson ?? this.manifestJson,
      isPinned: isPinned ?? this.isPinned,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'user_id': userId,
      'chapter_version_id': chapterVersionId,
      'chapter_id': chapterId,
      'story_id': storyId,
      'story_title': storyTitle,
      'chapter_number': chapterNumber,
      'chapter_title': chapterTitle,
      'media_format': mediaFormat,
      'publication_format': publicationFormat,
      'installed_dir': installedDir,
      'total_files': totalFiles,
      'total_bytes': totalBytes,
      'installed_at': installedAt,
      'last_read_at': lastReadAt,
      'manifest_json': manifestJson,
      'is_pinned': isPinned ? 1 : 0,
    };
  }

  factory OfflineChapter.fromMap(Map<String, dynamic> map) {
    return OfflineChapter(
      userId: map['user_id'] as String? ?? 'default_user',
      chapterVersionId: map['chapter_version_id'] as String,
      chapterId: map['chapter_id'] as String,
      storyId: map['story_id'] as String,
      storyTitle: map['story_title'] as String,
      chapterNumber: map['chapter_number'] as String,
      chapterTitle: map['chapter_title'] as String?,
      mediaFormat: map['media_format'] as String,
      publicationFormat: map['publication_format'] as String?,
      installedDir: map['installed_dir'] as String,
      totalFiles: (map['total_files'] as num).toInt(),
      totalBytes: (map['total_bytes'] as num).toInt(),
      installedAt: (map['installed_at'] as num).toInt(),
      lastReadAt: (map['last_read_at'] as num?)?.toInt(),
      manifestJson: map['manifest_json'] as String,
      isPinned: (map['is_pinned'] as num?)?.toInt() == 1,
    );
  }

  @override
  String toString() {
    return 'OfflineChapter(userId: $userId, versionId: $chapterVersionId, story: $storyTitle, chapter: $chapterNumber, installedAt: $installedAt, pinned: $isPinned)';
  }
}
