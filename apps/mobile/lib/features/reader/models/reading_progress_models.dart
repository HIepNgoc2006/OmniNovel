/// Draft tiến độ đọc cục bộ (Local Only, KHÔNG có writeEpoch)
/// Được tạo ngay khi user lướt đọc, dùng để lưu local checkpoint tức thì
class PendingReadingProgress {
  final String storyId;
  final String chapterId;
  final String? chapterVersionId;
  final String readingMode;
  final double progressPercentage;
  final double scrollPosition;

  /// 1-based indexing
  final int pageIndex;
  final String? anchorBlockId;
  final int? textOffset;
  final int? baseWriteEpoch;
  final int checkpointRevision;

  const PendingReadingProgress({
    required this.storyId,
    required this.chapterId,
    this.chapterVersionId,
    this.readingMode = 'WEBTOON',
    required this.progressPercentage,
    required this.scrollPosition,
    this.pageIndex = 1,
    this.anchorBlockId,
    this.textOffset,
    this.baseWriteEpoch,
    this.checkpointRevision = 1,
  });

  factory PendingReadingProgress.fromFlutterIndex({
    required String storyId,
    required String chapterId,
    String? chapterVersionId,
    String readingMode = 'WEBTOON',
    required double progressPercentage,
    required double scrollPosition,
    required int flutterPageIndex,
    String? anchorBlockId,
    int? textOffset,
    int? baseWriteEpoch,
    int checkpointRevision = 1,
  }) {
    return PendingReadingProgress(
      storyId: storyId,
      chapterId: chapterId,
      chapterVersionId: chapterVersionId,
      readingMode: readingMode,
      progressPercentage: progressPercentage,
      scrollPosition: scrollPosition,
      pageIndex: flutterPageIndex + 1, // 0-based -> 1-based
      anchorBlockId: anchorBlockId,
      textOffset: textOffset,
      baseWriteEpoch: baseWriteEpoch,
      checkpointRevision: checkpointRevision,
    );
  }

  /// Lấy 0-based index dùng nội bộ trong Flutter
  int get flutterPageIndex => (pageIndex - 1).clamp(0, 99999);
}

/// Network Payload gửi lên server - Immutable & Bắt buộc có writeEpoch canonical
class ReadingProgressPayload {
  final String chapterId;
  final String? chapterVersionId;
  final String readingMode;
  final double progressPercentage;
  final double scrollPosition;

  /// Server/DB pageIndex: 1-based indexing (min: 1)
  final int pageIndex;
  final String? anchorBlockId;
  final int? textOffset;
  final String? storyId;

  /// Required canonical server write epoch (Zero-fallback)
  final int writeEpoch;

  const ReadingProgressPayload({
    required this.chapterId,
    this.chapterVersionId,
    this.readingMode = 'WEBTOON',
    required this.progressPercentage,
    required this.scrollPosition,
    this.pageIndex = 1,
    this.anchorBlockId,
    this.textOffset,
    this.storyId,
    required this.writeEpoch,
  });

  /// Materialize draft cục bộ thành network payload với canonical writeEpoch
  factory ReadingProgressPayload.fromDraft(
    PendingReadingProgress draft, {
    required int writeEpoch,
  }) {
    return ReadingProgressPayload(
      storyId: draft.storyId,
      chapterId: draft.chapterId,
      chapterVersionId: draft.chapterVersionId,
      readingMode: draft.readingMode,
      progressPercentage: draft.progressPercentage,
      scrollPosition: draft.scrollPosition,
      pageIndex: draft.pageIndex,
      anchorBlockId: draft.anchorBlockId,
      textOffset: draft.textOffset,
      writeEpoch: writeEpoch,
    );
  }

  /// Factory helper chuyển từ Flutter 0-based page index sang 1-based server index
  factory ReadingProgressPayload.fromFlutterIndex({
    required String chapterId,
    String? chapterVersionId,
    String readingMode = 'WEBTOON',
    required double progressPercentage,
    required double scrollPosition,
    required int flutterPageIndex,
    String? anchorBlockId,
    int? textOffset,
    String? storyId,
    required int writeEpoch,
  }) {
    return ReadingProgressPayload(
      chapterId: chapterId,
      chapterVersionId: chapterVersionId,
      readingMode: readingMode,
      progressPercentage: progressPercentage,
      scrollPosition: scrollPosition,
      pageIndex: flutterPageIndex + 1, // 0-based -> 1-based
      anchorBlockId: anchorBlockId,
      textOffset: textOffset,
      storyId: storyId,
      writeEpoch: writeEpoch,
    );
  }

  /// Lấy 0-based index dùng nội bộ trong Flutter
  int get flutterPageIndex => (pageIndex - 1).clamp(0, 99999);

  Map<String, dynamic> toJson() => {
        'chapterId': chapterId,
        if (chapterVersionId != null) 'chapterVersionId': chapterVersionId,
        'readingMode': readingMode,
        'progressPercentage': progressPercentage,
        'scrollPosition': scrollPosition,
        'pageIndex': pageIndex,
        if (anchorBlockId != null) 'anchorBlockId': anchorBlockId,
        if (textOffset != null) 'textOffset': textOffset,
        if (storyId != null) 'storyId': storyId,
        'writeEpoch': writeEpoch,
      };
}

class ReadingProgressResponse {
  final String storyId;
  final String? chapterId;
  final String? chapterVersionId;
  final String readingMode;
  final double progressPercentage;
  final double scrollPosition;

  /// 1-based pageIndex từ DB
  final int pageIndex;
  final String? anchorBlockId;
  final int textOffset;
  final DateTime? updatedAt;
  final List<String> readChapterIds;

  /// Canonical server write epoch (Fail-closed nếu thiếu)
  final int writeEpoch;

  const ReadingProgressResponse({
    required this.storyId,
    this.chapterId,
    this.chapterVersionId,
    this.readingMode = 'WEBTOON',
    this.progressPercentage = 0,
    this.scrollPosition = 0,
    this.pageIndex = 1,
    this.anchorBlockId,
    this.textOffset = 0,
    this.updatedAt,
    this.readChapterIds = const [],
    required this.writeEpoch,
  });

  /// Lấy 0-based index dùng nội bộ trong Flutter
  int get flutterPageIndex => (pageIndex - 1).clamp(0, 99999);

  /// Kiểm tra xem người dùng đã đọc chapter nào chưa
  bool get hasProgress => chapterId != null;

  factory ReadingProgressResponse.fromJson(Map<String, dynamic> json) {
    final rawEpoch = json['writeEpoch'];
    if (rawEpoch == null) {
      throw const FormatException('Missing required field "writeEpoch" in ReadingProgressResponse');
    }

    return ReadingProgressResponse(
      storyId: json['storyId'] as String? ?? '',
      chapterId: json['chapterId'] as String?,
      chapterVersionId: json['chapterVersionId'] as String?,
      readingMode: json['readingMode'] as String? ?? 'WEBTOON',
      progressPercentage:
          (json['progressPercentage'] as num?)?.toDouble() ?? 0.0,
      scrollPosition: (json['scrollPosition'] as num?)?.toDouble() ?? 0.0,
      pageIndex: (json['pageIndex'] as num?)?.toInt() ?? 1,
      anchorBlockId: json['anchorBlockId'] as String?,
      textOffset: (json['textOffset'] as num?)?.toInt() ?? 0,
      updatedAt: json['updatedAt'] != null
          ? DateTime.tryParse(json['updatedAt'] as String)
          : null,
      readChapterIds: (json['readChapterIds'] as List<dynamic>?)
              ?.map((id) => id.toString())
              .toList() ??
          [],
      writeEpoch: (rawEpoch as num).toInt(),
    );
  }

  Map<String, dynamic> toJson() => {
        'storyId': storyId,
        'chapterId': chapterId,
        'chapterVersionId': chapterVersionId,
        'readingMode': readingMode,
        'progressPercentage': progressPercentage,
        'scrollPosition': scrollPosition,
        'pageIndex': pageIndex,
        'anchorBlockId': anchorBlockId,
        'textOffset': textOffset,
        'updatedAt': updatedAt?.toIso8601String(),
        'readChapterIds': readChapterIds,
        'writeEpoch': writeEpoch,
      };
}

/// Checkpoint lưu cục bộ vào SharedPreferences để bảo vệ tiến độ đọc khi app bị kill process đột ngột
class LocalReadingCheckpoint {
  final String storyId;
  final String chapterId;
  final String? chapterVersionId;
  final int pageIndex; // 1-based
  final double progressPercentage;
  final double scrollPosition;
  final String? anchorBlockId;
  final int? textOffset;
  final DateTime updatedAt;
  final bool isDirty;
  final int? baseWriteEpoch;
  final int checkpointRevision;

  const LocalReadingCheckpoint({
    required this.storyId,
    required this.chapterId,
    this.chapterVersionId,
    required this.pageIndex,
    required this.progressPercentage,
    required this.scrollPosition,
    this.anchorBlockId,
    this.textOffset,
    required this.updatedAt,
    this.isDirty = true,
    this.baseWriteEpoch,
    this.checkpointRevision = 1,
  });

  int get flutterPageIndex => (pageIndex - 1).clamp(0, 99999);

  LocalReadingCheckpoint copyWith({
    String? storyId,
    String? chapterId,
    String? chapterVersionId,
    int? pageIndex,
    double? progressPercentage,
    double? scrollPosition,
    String? anchorBlockId,
    int? textOffset,
    DateTime? updatedAt,
    bool? isDirty,
    int? baseWriteEpoch,
    int? checkpointRevision,
  }) {
    return LocalReadingCheckpoint(
      storyId: storyId ?? this.storyId,
      chapterId: chapterId ?? this.chapterId,
      chapterVersionId: chapterVersionId ?? this.chapterVersionId,
      pageIndex: pageIndex ?? this.pageIndex,
      progressPercentage: progressPercentage ?? this.progressPercentage,
      scrollPosition: scrollPosition ?? this.scrollPosition,
      anchorBlockId: anchorBlockId ?? this.anchorBlockId,
      textOffset: textOffset ?? this.textOffset,
      updatedAt: updatedAt ?? this.updatedAt,
      isDirty: isDirty ?? this.isDirty,
      baseWriteEpoch: baseWriteEpoch ?? this.baseWriteEpoch,
      checkpointRevision: checkpointRevision ?? this.checkpointRevision,
    );
  }

  factory LocalReadingCheckpoint.fromJson(Map<String, dynamic> json) {
    return LocalReadingCheckpoint(
      storyId: json['storyId'] as String,
      chapterId: json['chapterId'] as String,
      chapterVersionId: json['chapterVersionId'] as String?,
      pageIndex: (json['pageIndex'] as num?)?.toInt() ?? 1,
      progressPercentage:
          (json['progressPercentage'] as num?)?.toDouble() ?? 0.0,
      scrollPosition: (json['scrollPosition'] as num?)?.toDouble() ?? 0.0,
      anchorBlockId: json['anchorBlockId'] as String?,
      textOffset: (json['textOffset'] as num?)?.toInt() ?? 0,
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      isDirty: json['isDirty'] as bool? ?? true,
      baseWriteEpoch: (json['baseWriteEpoch'] as num?)?.toInt(),
      checkpointRevision: (json['checkpointRevision'] as num?)?.toInt() ?? 1,
    );
  }

  Map<String, dynamic> toJson() => {
        'storyId': storyId,
        'chapterId': chapterId,
        if (chapterVersionId != null) 'chapterVersionId': chapterVersionId,
        'pageIndex': pageIndex,
        'progressPercentage': progressPercentage,
        'scrollPosition': scrollPosition,
        if (anchorBlockId != null) 'anchorBlockId': anchorBlockId,
        if (textOffset != null) 'textOffset': textOffset,
        'updatedAt': updatedAt.toIso8601String(),
        'isDirty': isDirty,
        if (baseWriteEpoch != null) 'baseWriteEpoch': baseWriteEpoch,
        'checkpointRevision': checkpointRevision,
      };
}

/// Exception khi server từ chối write do epoch không khớp
class StaleWriteEpochException implements Exception {
  final String storyId;
  final int writeEpoch;
  final int? currentEpoch;

  const StaleWriteEpochException({
    required this.storyId,
    required this.writeEpoch,
    this.currentEpoch,
  });

  @override
  String toString() =>
      'StaleWriteEpochException: storyId=$storyId, writeEpoch=$writeEpoch, currentEpoch=$currentEpoch';
}
