/// Helper parse an toàn số nguyên từ dynamic (hỗ trợ cả int, num, String do PostgreSQL bigint TypeORM trả về)
int parseIntLike(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}

class Genre {
  final int id;
  final String name;
  final String slug;

  const Genre({
    required this.id,
    required this.name,
    required this.slug,
  });

  factory Genre.fromJson(Map<String, dynamic> json) {
    return Genre(
      id: parseIntLike(json['id']),
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

class VolumeSummary {
  final String id;
  final int volumeNumber;
  final String title;
  final String? coverUrl;

  const VolumeSummary({
    required this.id,
    required this.volumeNumber,
    required this.title,
    this.coverUrl,
  });

  factory VolumeSummary.fromJson(Map<String, dynamic> json) {
    return VolumeSummary(
      id: json['id'] as String? ?? '',
      volumeNumber: parseIntLike(json['volumeNumber']),
      title: json['title'] as String? ?? '',
      coverUrl: json['coverUrl'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'volumeNumber': volumeNumber,
        'title': title,
        'coverUrl': coverUrl,
      };
}

class ChapterItemSummary {
  final String id;
  final String? volumeId;
  final String chapterNumber;
  final String? title;
  final String? activeVersionId;
  final int viewsCount;
  final DateTime? createdAt;

  const ChapterItemSummary({
    required this.id,
    this.volumeId,
    required this.chapterNumber,
    this.title,
    this.activeVersionId,
    this.viewsCount = 0,
    this.createdAt,
  });

  factory ChapterItemSummary.fromJson(Map<String, dynamic> json) {
    return ChapterItemSummary(
      id: json['id'] as String? ?? '',
      volumeId: json['volumeId'] as String?,
      chapterNumber: json['chapterNumber']?.toString() ?? '1',
      title: json['title'] as String?,
      activeVersionId: json['activeVersionId'] as String?,
      viewsCount: parseIntLike(json['viewsCount']),
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        if (volumeId != null) 'volumeId': volumeId,
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
  final List<VolumeSummary> volumes;
  final List<ChapterItemSummary> chapters;

  const StoryEdition({
    required this.id,
    required this.editionName,
    this.isDefault = false,
    this.volumes = const [],
    this.chapters = const [],
  });

  factory StoryEdition.fromJson(Map<String, dynamic> json) {
    return StoryEdition(
      id: json['id'] as String? ?? '',
      editionName: json['editionName'] as String? ?? 'Default Edition',
      isDefault: json['isDefault'] as bool? ?? false,
      volumes: (json['volumes'] as List<dynamic>?)
              ?.map((v) => VolumeSummary.fromJson(v as Map<String, dynamic>))
              .toList() ??
          [],
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
        'volumes': volumes.map((v) => v.toJson()).toList(),
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
  final String? publicationFormat;
  final String? originCountry;
  final String? originalLanguage;
  final String status;
  final int viewsCount;
  final int followersCount;
  final List<Genre> genres;
  final List<ChapterItemSummary> latestChapters;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const StorySummary({
    required this.id,
    required this.slug,
    required this.title,
    this.summary,
    this.coverUrl,
    this.bannerUrl,
    this.mediaFormat = 'COMIC',
    this.publicationFormat,
    this.originCountry,
    this.originalLanguage,
    this.status = 'ONGOING',
    this.viewsCount = 0,
    this.followersCount = 0,
    this.genres = const [],
    this.latestChapters = const [],
    this.createdAt,
    this.updatedAt,
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
      publicationFormat: json['publicationFormat'] as String?,
      originCountry: json['originCountry'] as String?,
      originalLanguage: json['originalLanguage'] as String?,
      status: json['status'] as String? ?? 'ONGOING',
      viewsCount: parseIntLike(json['viewsCount']),
      followersCount: parseIntLike(json['followersCount']),
      genres: (json['genres'] as List<dynamic>?)
              ?.map((g) => Genre.fromJson(g as Map<String, dynamic>))
              .toList() ??
          [],
      latestChapters: (json['latestChapters'] as List<dynamic>?)
              ?.map((c) => ChapterItemSummary.fromJson(c as Map<String, dynamic>))
              .toList() ??
          [],
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
      updatedAt: json['updatedAt'] != null
          ? DateTime.tryParse(json['updatedAt'] as String)
          : null,
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
        if (publicationFormat != null) 'publicationFormat': publicationFormat,
        if (originCountry != null) 'originCountry': originCountry,
        if (originalLanguage != null) 'originalLanguage': originalLanguage,
        'status': status,
        'viewsCount': viewsCount,
        'followersCount': followersCount,
        'genres': genres.map((g) => g.toJson()).toList(),
        'latestChapters': latestChapters.map((c) => c.toJson()).toList(),
        if (createdAt != null) 'createdAt': createdAt!.toIso8601String(),
        if (updatedAt != null) 'updatedAt': updatedAt!.toIso8601String(),
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
  final String? publicationFormat;
  final String? originCountry;
  final String? originalLanguage;
  final String status;
  final String visibility;
  final int viewsCount;
  final int followersCount;
  final List<Genre> genres;
  final List<StoryEdition> editions;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const StoryDetail({
    required this.id,
    required this.slug,
    required this.title,
    this.summary,
    this.coverUrl,
    this.bannerUrl,
    this.mediaFormat = 'COMIC',
    this.publicationFormat,
    this.originCountry,
    this.originalLanguage,
    this.status = 'ONGOING',
    this.visibility = 'PUBLIC',
    this.viewsCount = 0,
    this.followersCount = 0,
    this.genres = const [],
    this.editions = const [],
    this.createdAt,
    this.updatedAt,
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

  /// Lấy danh sách volumes theo edition mặc định hoặc edition đầu tiên
  List<VolumeSummary> get defaultVolumes {
    if (editions.isEmpty) return [];
    final defaultEdition = editions.firstWhere(
      (e) => e.isDefault,
      orElse: () => editions.first,
    );
    return defaultEdition.volumes;
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
      publicationFormat: json['publicationFormat'] as String?,
      originCountry: json['originCountry'] as String?,
      originalLanguage: json['originalLanguage'] as String?,
      status: json['status'] as String? ?? 'ONGOING',
      visibility: json['visibility'] as String? ?? 'PUBLIC',
      viewsCount: parseIntLike(json['viewsCount']),
      followersCount: parseIntLike(json['followersCount']),
      genres: (json['genres'] as List<dynamic>?)
              ?.map((g) => Genre.fromJson(g as Map<String, dynamic>))
              .toList() ??
          [],
      editions: (json['editions'] as List<dynamic>?)
              ?.map((e) => StoryEdition.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
      updatedAt: json['updatedAt'] != null
          ? DateTime.tryParse(json['updatedAt'] as String)
          : null,
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
        if (publicationFormat != null) 'publicationFormat': publicationFormat,
        if (originCountry != null) 'originCountry': originCountry,
        if (originalLanguage != null) 'originalLanguage': originalLanguage,
        'status': status,
        'visibility': visibility,
        'viewsCount': viewsCount,
        'followersCount': followersCount,
        'genres': genres.map((g) => g.toJson()).toList(),
        'editions': editions.map((e) => e.toJson()).toList(),
        if (createdAt != null) 'createdAt': createdAt!.toIso8601String(),
        if (updatedAt != null) 'updatedAt': updatedAt!.toIso8601String(),
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

class StoryRankingsResponse {
  final List<StorySummary> topComics;
  final List<StorySummary> topNovels;

  const StoryRankingsResponse({
    this.topComics = const [],
    this.topNovels = const [],
  });

  factory StoryRankingsResponse.fromJson(Map<String, dynamic> json) {
    return StoryRankingsResponse(
      topComics: (json['topComics'] as List<dynamic>?)
              ?.map((s) => StorySummary.fromJson(s as Map<String, dynamic>))
              .toList() ??
          [],
      topNovels: (json['topNovels'] as List<dynamic>?)
              ?.map((s) => StorySummary.fromJson(s as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  Map<String, dynamic> toJson() => {
        'topComics': topComics.map((s) => s.toJson()).toList(),
        'topNovels': topNovels.map((s) => s.toJson()).toList(),
      };
}

class PaginationMeta {
  final int page;
  final int limit;
  final int total;
  final int totalPages;

  const PaginationMeta({
    required this.page,
    required this.limit,
    required this.total,
    required this.totalPages,
  });

  bool get hasNextPage => page < totalPages;

  factory PaginationMeta.fromJson(Map<String, dynamic> json) {
    return PaginationMeta(
      page: parseIntLike(json['page']),
      limit: parseIntLike(json['limit']),
      total: parseIntLike(json['total']),
      totalPages: parseIntLike(json['totalPages']),
    );
  }

  Map<String, dynamic> toJson() => {
        'page': page,
        'limit': limit,
        'total': total,
        'totalPages': totalPages,
      };
}

class PaginatedStoriesResponse {
  final List<StorySummary> data;
  final PaginationMeta pagination;

  const PaginatedStoriesResponse({
    this.data = const [],
    required this.pagination,
  });

  factory PaginatedStoriesResponse.fromJson(Map<String, dynamic> json) {
    return PaginatedStoriesResponse(
      data: (json['data'] as List<dynamic>?)
              ?.map((s) => StorySummary.fromJson(s as Map<String, dynamic>))
              .toList() ??
          [],
      pagination: json['pagination'] != null
          ? PaginationMeta.fromJson(json['pagination'] as Map<String, dynamic>)
          : const PaginationMeta(page: 1, limit: 20, total: 0, totalPages: 0),
    );
  }

  Map<String, dynamic> toJson() => {
        'data': data.map((s) => s.toJson()).toList(),
        'pagination': pagination.toJson(),
      };
}

class FindStoriesParams {
  final int page;
  final int limit;
  final String? format; // 'COMIC' | 'NOVEL'
  final String? genre;
  final String? status; // 'ONGOING' | 'COMPLETED' | 'HIATUS'
  final String? search;
  final String? sort; // 'LATEST' | 'VIEWS' | 'POPULAR'

  const FindStoriesParams({
    this.page = 1,
    this.limit = 20,
    this.format,
    this.genre,
    this.status,
    this.search,
    this.sort = 'LATEST',
  });

  Map<String, dynamic> toQueryParams() {
    return {
      'page': page.toString(),
      'limit': limit.toString(),
      if (format != null && format!.isNotEmpty) 'format': format!,
      if (genre != null && genre!.isNotEmpty) 'genre': genre!,
      if (status != null && status!.isNotEmpty) 'status': status!,
      if (search != null && search!.trim().isNotEmpty) 'search': search!.trim(),
      if (sort != null && sort!.isNotEmpty) 'sort': sort!,
    };
  }
}
