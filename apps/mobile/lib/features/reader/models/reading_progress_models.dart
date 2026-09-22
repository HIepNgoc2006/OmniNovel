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
  });

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
  });

  /// Lấy 0-based index dùng nội bộ trong Flutter
  int get flutterPageIndex => (pageIndex - 1).clamp(0, 99999);

  /// Kiểm tra xem người dùng đã đọc chapter nào chưa
  bool get hasProgress => chapterId != null;

  factory ReadingProgressResponse.fromJson(Map<String, dynamic> json) {
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
  final DateTime updatedAt;

  const LocalReadingCheckpoint({
    required this.storyId,
    required this.chapterId,
    this.chapterVersionId,
    required this.pageIndex,
    required this.progressPercentage,
    required this.scrollPosition,
    required this.updatedAt,
  });

  int get flutterPageIndex => (pageIndex - 1).clamp(0, 99999);

  factory LocalReadingCheckpoint.fromJson(Map<String, dynamic> json) {
    return LocalReadingCheckpoint(
      storyId: json['storyId'] as String? ?? '',
      chapterId: json['chapterId'] as String? ?? '',
      chapterVersionId: json['chapterVersionId'] as String?,
      pageIndex: (json['pageIndex'] as num?)?.toInt() ?? 1,
      progressPercentage:
          (json['progressPercentage'] as num?)?.toDouble() ?? 0.0,
      scrollPosition: (json['scrollPosition'] as num?)?.toDouble() ?? 0.0,
      updatedAt: json['updatedAt'] != null
          ? DateTime.parse(json['updatedAt'] as String)
          : DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() => {
        'storyId': storyId,
        'chapterId': chapterId,
        'chapterVersionId': chapterVersionId,
        'pageIndex': pageIndex,
        'progressPercentage': progressPercentage,
        'scrollPosition': scrollPosition,
        'updatedAt': updatedAt.toIso8601String(),
      };
}
