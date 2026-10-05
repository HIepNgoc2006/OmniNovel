import 'package:flutter/foundation.dart';

/// Lỗi định danh khi cố gắng thực thi thao tác Guest với scope không hợp lệ.
class InvalidGuestScopeException implements Exception {
  final String message;

  const InvalidGuestScopeException(this.message);

  @override
  String toString() => 'InvalidGuestScopeException: $message';
}

/// Model Dấu Trang Cục Bộ (Local Bookmark)
/// Lưu trong bảng SQLite `local_library_bookmarks`.
@immutable
class LocalBookmark {
  final String ownerScope;
  final String storyId;
  final String title;
  final String? slug;
  final String? coverUrl;
  final DateTime createdAt;

  const LocalBookmark({
    required this.ownerScope,
    required this.storyId,
    required this.title,
    this.slug,
    this.coverUrl,
    required this.createdAt,
  });

  Map<String, dynamic> toMap() => {
        'owner_scope': ownerScope,
        'story_id': storyId,
        'title': title,
        'slug': slug,
        'cover_url': coverUrl,
        'created_at': createdAt.millisecondsSinceEpoch,
      };

  factory LocalBookmark.fromMap(Map<String, dynamic> map) {
    return LocalBookmark(
      ownerScope: map['owner_scope'] as String,
      storyId: map['story_id'] as String,
      title: map['title'] as String,
      slug: map['slug'] as String?,
      coverUrl: map['cover_url'] as String?,
      createdAt: DateTime.fromMillisecondsSinceEpoch(
        map['created_at'] as int,
        isUtc: true,
      ),
    );
  }

  LocalBookmark copyWith({
    String? ownerScope,
    String? storyId,
    String? title,
    String? slug,
    String? coverUrl,
    DateTime? createdAt,
  }) {
    return LocalBookmark(
      ownerScope: ownerScope ?? this.ownerScope,
      storyId: storyId ?? this.storyId,
      title: title ?? this.title,
      slug: slug ?? this.slug,
      coverUrl: coverUrl ?? this.coverUrl,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is LocalBookmark &&
          runtimeType == other.runtimeType &&
          ownerScope == other.ownerScope &&
          storyId == other.storyId &&
          title == other.title &&
          slug == other.slug &&
          coverUrl == other.coverUrl &&
          createdAt.millisecondsSinceEpoch ==
              other.createdAt.millisecondsSinceEpoch;

  @override
  int get hashCode => Object.hash(
        ownerScope,
        storyId,
        title,
        slug,
        coverUrl,
        createdAt.millisecondsSinceEpoch,
      );
}

/// Model Tiến Độ Đọc Cục Bộ (Local Reading Progress)
/// Lưu trong bảng SQLite `local_reading_progress`.
/// Nắm giữ vị trí đọc canonical hiện tại của người dùng.
@immutable
class LocalReadingProgress {
  final String ownerScope;
  final String storyId;
  final String chapterId;
  final String? chapterVersionId;
  final String readingMode;
  final double progressPercentage;
  final double scrollPosition;

  /// 1-based index (Manga paged / novel page)
  final int pageIndex;
  final String? anchorBlockId;
  final int? textOffset;
  final DateTime updatedAt;
  final DateTime deviceTimestamp;

  const LocalReadingProgress({
    required this.ownerScope,
    required this.storyId,
    required this.chapterId,
    this.chapterVersionId,
    this.readingMode = 'WEBTOON',
    required this.progressPercentage,
    required this.scrollPosition,
    this.pageIndex = 1,
    this.anchorBlockId,
    this.textOffset,
    required this.updatedAt,
    required this.deviceTimestamp,
  });

  Map<String, dynamic> toMap() => {
        'owner_scope': ownerScope,
        'story_id': storyId,
        'chapter_id': chapterId,
        'chapter_version_id': chapterVersionId,
        'reading_mode': readingMode,
        'progress_percentage': progressPercentage,
        'scroll_position': scrollPosition,
        'page_index': pageIndex >= 1 ? pageIndex : 1,
        'anchor_block_id': anchorBlockId,
        'text_offset': textOffset,
        'updated_at': updatedAt.millisecondsSinceEpoch,
        'device_timestamp': deviceTimestamp.millisecondsSinceEpoch,
      };

  factory LocalReadingProgress.fromMap(Map<String, dynamic> map) {
    return LocalReadingProgress(
      ownerScope: map['owner_scope'] as String,
      storyId: map['story_id'] as String,
      chapterId: map['chapter_id'] as String,
      chapterVersionId: map['chapter_version_id'] as String?,
      readingMode: map['reading_mode'] as String? ?? 'WEBTOON',
      progressPercentage: (map['progress_percentage'] as num).toDouble(),
      scrollPosition: (map['scroll_position'] as num).toDouble(),
      pageIndex: (map['page_index'] as int?) ?? 1,
      anchorBlockId: map['anchor_block_id'] as String?,
      textOffset: map['text_offset'] as int?,
      updatedAt: DateTime.fromMillisecondsSinceEpoch(
        map['updated_at'] as int,
        isUtc: true,
      ),
      deviceTimestamp: DateTime.fromMillisecondsSinceEpoch(
        map['device_timestamp'] as int,
        isUtc: true,
      ),
    );
  }

  LocalReadingProgress copyWith({
    String? ownerScope,
    String? storyId,
    String? chapterId,
    String? chapterVersionId,
    String? readingMode,
    double? progressPercentage,
    double? scrollPosition,
    int? pageIndex,
    String? anchorBlockId,
    int? textOffset,
    DateTime? updatedAt,
    DateTime? deviceTimestamp,
  }) {
    return LocalReadingProgress(
      ownerScope: ownerScope ?? this.ownerScope,
      storyId: storyId ?? this.storyId,
      chapterId: chapterId ?? this.chapterId,
      chapterVersionId: chapterVersionId ?? this.chapterVersionId,
      readingMode: readingMode ?? this.readingMode,
      progressPercentage: progressPercentage ?? this.progressPercentage,
      scrollPosition: scrollPosition ?? this.scrollPosition,
      pageIndex: pageIndex ?? this.pageIndex,
      anchorBlockId: anchorBlockId ?? this.anchorBlockId,
      textOffset: textOffset ?? this.textOffset,
      updatedAt: updatedAt ?? this.updatedAt,
      deviceTimestamp: deviceTimestamp ?? this.deviceTimestamp,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is LocalReadingProgress &&
          runtimeType == other.runtimeType &&
          ownerScope == other.ownerScope &&
          storyId == other.storyId &&
          chapterId == other.chapterId &&
          chapterVersionId == other.chapterVersionId &&
          readingMode == other.readingMode &&
          progressPercentage == other.progressPercentage &&
          scrollPosition == other.scrollPosition &&
          pageIndex == other.pageIndex &&
          anchorBlockId == other.anchorBlockId &&
          textOffset == other.textOffset &&
          updatedAt.millisecondsSinceEpoch ==
              other.updatedAt.millisecondsSinceEpoch &&
          deviceTimestamp.millisecondsSinceEpoch ==
              other.deviceTimestamp.millisecondsSinceEpoch;

  @override
  int get hashCode => Object.hash(
        ownerScope,
        storyId,
        chapterId,
        chapterVersionId,
        readingMode,
        progressPercentage,
        scrollPosition,
        pageIndex,
        anchorBlockId,
        textOffset,
        updatedAt.millisecondsSinceEpoch,
        deviceTimestamp.millisecondsSinceEpoch,
      );
}

/// Model Lịch Sử Đọc Cục Bộ (Local Reading History)
/// Lưu trong bảng SQLite `local_reading_history`.
/// Snapshot 1 bản ghi cho mỗi chương đã đọc, với tiến độ đạt được cao nhất (monotonic MAX).
@immutable
class LocalReadingHistory {
  final String ownerScope;
  final String storyId;
  final String chapterId;
  final String? chapterVersionId;
  final String storyTitle;
  final String? storySlug;
  final String? storyCoverUrl;
  final String chapterNumber;
  final String? chapterTitle;
  final double progressPercentage;
  final DateTime lastReadAt;

  const LocalReadingHistory({
    required this.ownerScope,
    required this.storyId,
    required this.chapterId,
    this.chapterVersionId,
    required this.storyTitle,
    this.storySlug,
    this.storyCoverUrl,
    required this.chapterNumber,
    this.chapterTitle,
    required this.progressPercentage,
    required this.lastReadAt,
  });

  Map<String, dynamic> toMap() => {
        'owner_scope': ownerScope,
        'story_id': storyId,
        'chapter_id': chapterId,
        'chapter_version_id': chapterVersionId,
        'story_title': storyTitle,
        'story_slug': storySlug,
        'story_cover_url': storyCoverUrl,
        'chapter_number': chapterNumber,
        'chapter_title': chapterTitle,
        'progress_percentage': progressPercentage,
        'last_read_at': lastReadAt.millisecondsSinceEpoch,
      };

  factory LocalReadingHistory.fromMap(Map<String, dynamic> map) {
    return LocalReadingHistory(
      ownerScope: map['owner_scope'] as String,
      storyId: map['story_id'] as String,
      chapterId: map['chapter_id'] as String,
      chapterVersionId: map['chapter_version_id'] as String?,
      storyTitle: map['story_title'] as String,
      storySlug: map['story_slug'] as String?,
      storyCoverUrl: map['story_cover_url'] as String?,
      chapterNumber: map['chapter_number'] as String,
      chapterTitle: map['chapter_title'] as String?,
      progressPercentage: (map['progress_percentage'] as num).toDouble(),
      lastReadAt: DateTime.fromMillisecondsSinceEpoch(
        map['last_read_at'] as int,
        isUtc: true,
      ),
    );
  }

  LocalReadingHistory copyWith({
    String? ownerScope,
    String? storyId,
    String? chapterId,
    String? chapterVersionId,
    String? storyTitle,
    String? storySlug,
    String? storyCoverUrl,
    String? chapterNumber,
    String? chapterTitle,
    double? progressPercentage,
    DateTime? lastReadAt,
  }) {
    return LocalReadingHistory(
      ownerScope: ownerScope ?? this.ownerScope,
      storyId: storyId ?? this.storyId,
      chapterId: chapterId ?? this.chapterId,
      chapterVersionId: chapterVersionId ?? this.chapterVersionId,
      storyTitle: storyTitle ?? this.storyTitle,
      storySlug: storySlug ?? this.storySlug,
      storyCoverUrl: storyCoverUrl ?? this.storyCoverUrl,
      chapterNumber: chapterNumber ?? this.chapterNumber,
      chapterTitle: chapterTitle ?? this.chapterTitle,
      progressPercentage: progressPercentage ?? this.progressPercentage,
      lastReadAt: lastReadAt ?? this.lastReadAt,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is LocalReadingHistory &&
          runtimeType == other.runtimeType &&
          ownerScope == other.ownerScope &&
          storyId == other.storyId &&
          chapterId == other.chapterId &&
          chapterVersionId == other.chapterVersionId &&
          storyTitle == other.storyTitle &&
          storySlug == other.storySlug &&
          storyCoverUrl == other.storyCoverUrl &&
          chapterNumber == other.chapterNumber &&
          chapterTitle == other.chapterTitle &&
          progressPercentage == other.progressPercentage &&
          lastReadAt.millisecondsSinceEpoch ==
              other.lastReadAt.millisecondsSinceEpoch;

  @override
  int get hashCode => Object.hash(
        ownerScope,
        storyId,
        chapterId,
        chapterVersionId,
        storyTitle,
        storySlug,
        storyCoverUrl,
        chapterNumber,
        chapterTitle,
        progressPercentage,
        lastReadAt.millisecondsSinceEpoch,
      );
}
