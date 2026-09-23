import '../../story/models/story_models.dart' show parseIntLike;

enum LibraryStatusFilter {
  all,
  ongoing,
  completed,
  hiatus;

  String get label {
    switch (this) {
      case LibraryStatusFilter.all:
        return 'Tất cả';
      case LibraryStatusFilter.ongoing:
        return 'Đang ra';
      case LibraryStatusFilter.completed:
        return 'Hoàn thành';
      case LibraryStatusFilter.hiatus:
        return 'Tạm ngưng';
    }
  }

  String? get apiValue {
    switch (this) {
      case LibraryStatusFilter.all:
        return null;
      case LibraryStatusFilter.ongoing:
        return 'ONGOING';
      case LibraryStatusFilter.completed:
        return 'COMPLETED';
      case LibraryStatusFilter.hiatus:
        return 'HIATUS';
    }
  }
}

class PaginationMeta {
  final int page;
  final int limit;
  final int totalItems;
  final int totalPages;

  const PaginationMeta({
    required this.page,
    required this.limit,
    required this.totalItems,
    required this.totalPages,
  });

  factory PaginationMeta.fromJson(Map<String, dynamic> json) {
    return PaginationMeta(
      page: parseIntLike(json['page']),
      limit: parseIntLike(json['limit']),
      totalItems: parseIntLike(json['totalItems']),
      totalPages: parseIntLike(json['totalPages']),
    );
  }

  Map<String, dynamic> toJson() => {
        'page': page,
        'limit': limit,
        'totalItems': totalItems,
        'totalPages': totalPages,
      };
}

class BookmarkStatusResponse {
  final bool isBookmarked;

  const BookmarkStatusResponse({required this.isBookmarked});

  factory BookmarkStatusResponse.fromJson(Map<String, dynamic> json) {
    return BookmarkStatusResponse(
      isBookmarked: json['isBookmarked'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() => {'isBookmarked': isBookmarked};
}

class LibraryStorySummary {
  final String id;
  final String title;
  final String slug;
  final String? coverUrl;
  final String mediaFormat;
  final String status;
  final int totalChapters;

  const LibraryStorySummary({
    required this.id,
    required this.title,
    required this.slug,
    this.coverUrl,
    required this.mediaFormat,
    required this.status,
    required this.totalChapters,
  });

  factory LibraryStorySummary.fromJson(Map<String, dynamic> json) {
    return LibraryStorySummary(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      slug: json['slug'] as String? ?? '',
      coverUrl: json['coverUrl'] as String?,
      mediaFormat: json['mediaFormat'] as String? ?? 'COMIC',
      status: json['status'] as String? ?? 'ONGOING',
      totalChapters: parseIntLike(json['totalChapters']),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'slug': slug,
        'coverUrl': coverUrl,
        'mediaFormat': mediaFormat,
        'status': status,
        'totalChapters': totalChapters,
      };
}

class LibraryChapterSummary {
  final String id;
  final String title;
  final int chapterNumber;

  const LibraryChapterSummary({
    required this.id,
    required this.title,
    required this.chapterNumber,
  });

  factory LibraryChapterSummary.fromJson(Map<String, dynamic> json) {
    return LibraryChapterSummary(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      chapterNumber: parseIntLike(json['chapterNumber']),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'chapterNumber': chapterNumber,
      };
}

class ResumeSnapshot {
  final String? chapterVersionId;
  final String readingMode;
  final double progressPercentage;
  final double scrollPosition;
  final int pageIndex; // 1-based
  final String? anchorBlockId;
  final int textOffset;

  const ResumeSnapshot({
    this.chapterVersionId,
    required this.readingMode,
    required this.progressPercentage,
    required this.scrollPosition,
    required this.pageIndex,
    this.anchorBlockId,
    required this.textOffset,
  });

  int get flutterPageIndex => (pageIndex - 1).clamp(0, 99999);

  factory ResumeSnapshot.fromJson(Map<String, dynamic> json) {
    return ResumeSnapshot(
      chapterVersionId: json['chapterVersionId'] as String?,
      readingMode: json['readingMode'] as String? ?? 'WEBTOON',
      progressPercentage:
          (json['progressPercentage'] as num?)?.toDouble() ?? 0.0,
      scrollPosition: (json['scrollPosition'] as num?)?.toDouble() ?? 0.0,
      pageIndex: (json['pageIndex'] as num?)?.toInt() ?? 1,
      anchorBlockId: json['anchorBlockId'] as String?,
      textOffset: (json['textOffset'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'chapterVersionId': chapterVersionId,
        'readingMode': readingMode,
        'progressPercentage': progressPercentage,
        'scrollPosition': scrollPosition,
        'pageIndex': pageIndex,
        'anchorBlockId': anchorBlockId,
        'textOffset': textOffset,
      };
}

class ReadingHistoryItem {
  final LibraryStorySummary story;
  final LibraryChapterSummary chapter;
  final ResumeSnapshot resume;
  final DateTime updatedAt;

  const ReadingHistoryItem({
    required this.story,
    required this.chapter,
    required this.resume,
    required this.updatedAt,
  });

  factory ReadingHistoryItem.fromJson(Map<String, dynamic> json) {
    return ReadingHistoryItem(
      story: LibraryStorySummary.fromJson(json['story'] as Map<String, dynamic>),
      chapter: LibraryChapterSummary.fromJson(
          json['chapter'] as Map<String, dynamic>),
      resume: ResumeSnapshot.fromJson(json['resume'] as Map<String, dynamic>),
      updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() => {
        'story': story.toJson(),
        'chapter': chapter.toJson(),
        'resume': resume.toJson(),
        'updatedAt': updatedAt.toIso8601String(),
      };
}

class PaginatedReadingHistoryResponse {
  final List<ReadingHistoryItem> data;
  final PaginationMeta pagination;

  const PaginatedReadingHistoryResponse({
    required this.data,
    required this.pagination,
  });

  factory PaginatedReadingHistoryResponse.fromJson(Map<String, dynamic> json) {
    return PaginatedReadingHistoryResponse(
      data: (json['data'] as List<dynamic>?)
              ?.map(
                  (e) => ReadingHistoryItem.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      pagination: PaginationMeta.fromJson(
          json['pagination'] as Map<String, dynamic>? ?? {}),
    );
  }

  Map<String, dynamic> toJson() => {
        'data': data.map((e) => e.toJson()).toList(),
        'pagination': pagination.toJson(),
      };
}

class BookmarkedStoryItem {
  final LibraryStorySummary story;
  final DateTime bookmarkedAt;
  final int unreadChapterCount;

  const BookmarkedStoryItem({
    required this.story,
    required this.bookmarkedAt,
    required this.unreadChapterCount,
  });

  factory BookmarkedStoryItem.fromJson(Map<String, dynamic> json) {
    return BookmarkedStoryItem(
      story: LibraryStorySummary.fromJson(json['story'] as Map<String, dynamic>),
      bookmarkedAt:
          DateTime.tryParse(json['bookmarkedAt'] as String? ?? '') ??
              DateTime.now(),
      unreadChapterCount: parseIntLike(json['unreadChapterCount']),
    );
  }

  Map<String, dynamic> toJson() => {
        'story': story.toJson(),
        'bookmarkedAt': bookmarkedAt.toIso8601String(),
        'unreadChapterCount': unreadChapterCount,
      };
}

class PaginatedBookmarksResponse {
  final List<BookmarkedStoryItem> data;
  final PaginationMeta pagination;

  const PaginatedBookmarksResponse({
    required this.data,
    required this.pagination,
  });

  factory PaginatedBookmarksResponse.fromJson(Map<String, dynamic> json) {
    return PaginatedBookmarksResponse(
      data: (json['data'] as List<dynamic>?)
              ?.map(
                  (e) => BookmarkedStoryItem.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      pagination: PaginationMeta.fromJson(
          json['pagination'] as Map<String, dynamic>? ?? {}),
    );
  }

  Map<String, dynamic> toJson() => {
        'data': data.map((e) => e.toJson()).toList(),
        'pagination': pagination.toJson(),
      };
}
