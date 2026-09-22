class Genre {
  final String id;
  final String name;
  final String slug;

  const Genre({
    required this.id,
    required this.name,
    required this.slug,
  });

  factory Genre.fromJson(Map<String, dynamic> json) {
    return Genre(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      slug: json['slug'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'slug': slug,
      };
}

class ChapterItemSummary {
  final String id;
  final String chapterNumber;
  final String? title;
  final String? activeVersionId;
  final int viewsCount;
  final DateTime? createdAt;

  const ChapterItemSummary({
    required this.id,
    required this.chapterNumber,
    this.title,
    this.activeVersionId,
    this.viewsCount = 0,
    this.createdAt,
  });

  factory ChapterItemSummary.fromJson(Map<String, dynamic> json) {
    return ChapterItemSummary(
      id: json['id'] as String? ?? '',
      chapterNumber: json['chapterNumber']?.toString() ?? '1',
      title: json['title'] as String?,
      activeVersionId: json['activeVersionId'] as String?,
      viewsCount: (json['viewsCount'] as num?)?.toInt() ?? 0,
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'chapterNumber': chapterNumber,
        'title': title,
        'activeVersionId': activeVersionId,
        'viewsCount': viewsCount,
        'createdAt': createdAt?.toIso8601String(),
      };
}

class StoryEdition {
  final String id;
  final String editionName;
  final bool isDefault;
  final List<ChapterItemSummary> chapters;

  const StoryEdition({
    required this.id,
    required this.editionName,
    this.isDefault = false,
    this.chapters = const [],
  });

  factory StoryEdition.fromJson(Map<String, dynamic> json) {
    return StoryEdition(
      id: json['id'] as String? ?? '',
      editionName: json['editionName'] as String? ?? 'Default Edition',
      isDefault: json['isDefault'] as bool? ?? false,
      chapters: (json['chapters'] as List<dynamic>?)
              ?.map((c) => ChapterItemSummary.fromJson(c as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'editionName': editionName,
        'isDefault': isDefault,
        'chapters': chapters.map((c) => c.toJson()).toList(),
      };
}

class StorySummary {
  final String id;
  final String slug;
  final String title;
  final String? summary;
  final String? coverUrl;
  final String? bannerUrl;
  final String mediaFormat;
  final String status;
  final int viewsCount;
  final int followersCount;
  final List<Genre> genres;
  final List<ChapterItemSummary> latestChapters;

  const StorySummary({
    required this.id,
    required this.slug,
    required this.title,
    this.summary,
    this.coverUrl,
    this.bannerUrl,
    this.mediaFormat = 'COMIC',
    this.status = 'ONGOING',
    this.viewsCount = 0,
    this.followersCount = 0,
    this.genres = const [],
    this.latestChapters = const [],
  });

  factory StorySummary.fromJson(Map<String, dynamic> json) {
    return StorySummary(
      id: json['id'] as String? ?? '',
      slug: json['slug'] as String? ?? '',
      title: json['title'] as String? ?? '',
      summary: json['summary'] as String?,
      coverUrl: json['coverUrl'] as String?,
      bannerUrl: json['bannerUrl'] as String?,
      mediaFormat: json['mediaFormat'] as String? ?? 'COMIC',
      status: json['status'] as String? ?? 'ONGOING',
      viewsCount: (json['viewsCount'] as num?)?.toInt() ?? 0,
      followersCount: (json['followersCount'] as num?)?.toInt() ?? 0,
      genres: (json['genres'] as List<dynamic>?)
              ?.map((g) => Genre.fromJson(g as Map<String, dynamic>))
              .toList() ??
          [],
      latestChapters: (json['latestChapters'] as List<dynamic>?)
              ?.map((c) => ChapterItemSummary.fromJson(c as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'slug': slug,
        'title': title,
        'summary': summary,
        'coverUrl': coverUrl,
        'bannerUrl': bannerUrl,
        'mediaFormat': mediaFormat,
        'status': status,
        'viewsCount': viewsCount,
        'followersCount': followersCount,
        'genres': genres.map((g) => g.toJson()).toList(),
        'latestChapters': latestChapters.map((c) => c.toJson()).toList(),
      };
}

class StoryDetail {
  final String id;
  final String slug;
  final String title;
  final String? summary;
  final String? coverUrl;
  final String? bannerUrl;
  final String mediaFormat;
  final String status;
  final String visibility;
  final int viewsCount;
  final int followersCount;
  final List<Genre> genres;
  final List<StoryEdition> editions;

  const StoryDetail({
    required this.id,
    required this.slug,
    required this.title,
    this.summary,
    this.coverUrl,
    this.bannerUrl,
    this.mediaFormat = 'COMIC',
    this.status = 'ONGOING',
    this.visibility = 'PUBLIC',
    this.viewsCount = 0,
    this.followersCount = 0,
    this.genres = const [],
    this.editions = const [],
  });

  /// Lấy danh sách chapter theo edition mặc định hoặc edition đầu tiên
  List<ChapterItemSummary> get defaultChapters {
    if (editions.isEmpty) return [];
    final defaultEdition = editions.firstWhere(
      (e) => e.isDefault,
      orElse: () => editions.first,
    );
    return defaultEdition.chapters;
  }

  factory StoryDetail.fromJson(Map<String, dynamic> json) {
    return StoryDetail(
      id: json['id'] as String? ?? '',
      slug: json['slug'] as String? ?? '',
      title: json['title'] as String? ?? '',
      summary: json['summary'] as String?,
      coverUrl: json['coverUrl'] as String?,
      bannerUrl: json['bannerUrl'] as String?,
      mediaFormat: json['mediaFormat'] as String? ?? 'COMIC',
      status: json['status'] as String? ?? 'ONGOING',
      visibility: json['visibility'] as String? ?? 'PUBLIC',
      viewsCount: (json['viewsCount'] as num?)?.toInt() ?? 0,
      followersCount: (json['followersCount'] as num?)?.toInt() ?? 0,
      genres: (json['genres'] as List<dynamic>?)
              ?.map((g) => Genre.fromJson(g as Map<String, dynamic>))
              .toList() ??
          [],
      editions: (json['editions'] as List<dynamic>?)
              ?.map((e) => StoryEdition.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'slug': slug,
        'title': title,
        'summary': summary,
        'coverUrl': coverUrl,
        'bannerUrl': bannerUrl,
        'mediaFormat': mediaFormat,
        'status': status,
        'visibility': visibility,
        'viewsCount': viewsCount,
        'followersCount': followersCount,
        'genres': genres.map((g) => g.toJson()).toList(),
        'editions': editions.map((e) => e.toJson()).toList(),
      };
}

class FeaturedStoriesResponse {
  final List<StorySummary> hotStories;
  final List<StorySummary> banners;

  const FeaturedStoriesResponse({
    this.hotStories = const [],
    this.banners = const [],
  });

  factory FeaturedStoriesResponse.fromJson(Map<String, dynamic> json) {
    return FeaturedStoriesResponse(
      hotStories: (json['hotStories'] as List<dynamic>?)
              ?.map((s) => StorySummary.fromJson(s as Map<String, dynamic>))
              .toList() ??
          [],
      banners: (json['banners'] as List<dynamic>?)
              ?.map((s) => StorySummary.fromJson(s as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  Map<String, dynamic> toJson() => {
        'hotStories': hotStories.map((s) => s.toJson()).toList(),
        'banners': banners.map((s) => s.toJson()).toList(),
      };
}
