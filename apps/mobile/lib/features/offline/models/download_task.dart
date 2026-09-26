enum DownloadTaskStatus {
  queued('QUEUED'),
  downloading('DOWNLOADING'),
  verifying('VERIFYING'),
  ready('READY'),
  paused('PAUSED'),
  failed('FAILED'),
  cancelled('CANCELLED');

  final String value;
  const DownloadTaskStatus(this.value);

  static DownloadTaskStatus fromString(String val) {
    return DownloadTaskStatus.values.firstWhere(
      (e) => e.value == val.toUpperCase(),
      orElse: () => DownloadTaskStatus.failed,
    );
  }
}

/// Mô hình biểu diễn một tác vụ tải gói chương truyện trong hàng đợi.
class DownloadTask {
  final String taskId;
  final String userId;
  final String chapterVersionId;
  final String chapterId;
  final String storyId;
  final String storyTitle;
  final String chapterNumber;
  final String mediaFormat; // 'COMIC' | 'NOVEL'
  final DownloadTaskStatus status;
  final int downloadedBytes;
  final int totalBytes;
  final double progressFraction;
  final String? downloadUrl;
  final String? sha256Hash;
  final String? errorMessage;
  final int createdAt; // epoch ms
  final int updatedAt; // epoch ms

  const DownloadTask({
    required this.taskId,
    this.userId = 'default_user',
    required this.chapterVersionId,
    required this.chapterId,
    required this.storyId,
    required this.storyTitle,
    required this.chapterNumber,
    required this.mediaFormat,
    required this.status,
    this.downloadedBytes = 0,
    this.totalBytes = 0,
    this.progressFraction = 0.0,
    this.downloadUrl,
    this.sha256Hash,
    this.errorMessage,
    required this.createdAt,
    required this.updatedAt,
  });

  DownloadTask copyWith({
    String? taskId,
    String? userId,
    String? chapterVersionId,
    String? chapterId,
    String? storyId,
    String? storyTitle,
    String? chapterNumber,
    String? mediaFormat,
    DownloadTaskStatus? status,
    int? downloadedBytes,
    int? totalBytes,
    double? progressFraction,
    String? downloadUrl,
    String? sha256Hash,
    String? errorMessage,
    bool clearErrorMessage = false,
    int? createdAt,
    int? updatedAt,
  }) {
    return DownloadTask(
      taskId: taskId ?? this.taskId,
      userId: userId ?? this.userId,
      chapterVersionId: chapterVersionId ?? this.chapterVersionId,
      chapterId: chapterId ?? this.chapterId,
      storyId: storyId ?? this.storyId,
      storyTitle: storyTitle ?? this.storyTitle,
      chapterNumber: chapterNumber ?? this.chapterNumber,
      mediaFormat: mediaFormat ?? this.mediaFormat,
      status: status ?? this.status,
      downloadedBytes: downloadedBytes ?? this.downloadedBytes,
      totalBytes: totalBytes ?? this.totalBytes,
      progressFraction: progressFraction ?? this.progressFraction,
      downloadUrl: downloadUrl ?? this.downloadUrl,
      sha256Hash: sha256Hash ?? this.sha256Hash,
      errorMessage: clearErrorMessage ? null : (errorMessage ?? this.errorMessage),
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'task_id': taskId,
      'user_id': userId,
      'chapter_version_id': chapterVersionId,
      'chapter_id': chapterId,
      'story_id': storyId,
      'story_title': storyTitle,
      'chapter_number': chapterNumber,
      'media_format': mediaFormat,
      'status': status.value,
      'downloaded_bytes': downloadedBytes,
      'total_bytes': totalBytes,
      'progress_fraction': progressFraction,
      'download_url': downloadUrl,
      'sha256_hash': sha256Hash,
      'error_message': errorMessage,
      'created_at': createdAt,
      'updated_at': updatedAt,
    };
  }

  factory DownloadTask.fromMap(Map<String, dynamic> map) {
    return DownloadTask(
      taskId: map['task_id'] as String,
      userId: map['user_id'] as String? ?? 'default_user',
      chapterVersionId: map['chapter_version_id'] as String,
      chapterId: map['chapter_id'] as String,
      storyId: map['story_id'] as String,
      storyTitle: map['story_title'] as String,
      chapterNumber: map['chapter_number'] as String,
      mediaFormat: map['media_format'] as String,
      status: DownloadTaskStatus.fromString(map['status'] as String),
      downloadedBytes: (map['downloaded_bytes'] as num?)?.toInt() ?? 0,
      totalBytes: (map['total_bytes'] as num?)?.toInt() ?? 0,
      progressFraction: (map['progress_fraction'] as num?)?.toDouble() ?? 0.0,
      downloadUrl: map['download_url'] as String?,
      sha256Hash: map['sha256_hash'] as String?,
      errorMessage: map['error_message'] as String?,
      createdAt: (map['created_at'] as num).toInt(),
      updatedAt: (map['updated_at'] as num).toInt(),
    );
  }

  @override
  String toString() {
    return 'DownloadTask(id: $taskId, user: $userId, versionId: $chapterVersionId, status: ${status.value}, progress: ${(progressFraction * 100).toStringAsFixed(1)}%)';
  }
}
