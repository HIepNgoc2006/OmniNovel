class ChapterPage {
  final String assetId;
  final int sortOrder;
  final String? assetType;
  final int? width;
  final int? height;
  final String? storageKey; // Opaque metadata only; client không resolve URL từ key này

  const ChapterPage({
    required this.assetId,
    required this.sortOrder,
    this.assetType,
    this.width,
    this.height,
    this.storageKey,
  });

  /// Tính toán aspect ratio (width / height) an toàn
  /// Nếu thiếu thông số width/height, fallback về tỉ lệ chuẩn Webtoon 0.65 (khoảng 1080/1660)
  double get aspectRatio {
    if (width != null && height != null && height! > 0 && width! > 0) {
      return width! / height!;
    }
    return 0.65;
  }

  factory ChapterPage.fromJson(Map<String, dynamic> json) {
    return ChapterPage(
      assetId: json['id'] as String? ?? json['assetId'] as String? ?? '',
      sortOrder: (json['sortOrder'] as num?)?.toInt() ?? 0,
      assetType: json['assetType'] as String?,
      width: (json['width'] as num?)?.toInt(),
      height: (json['height'] as num?)?.toInt(),
      storageKey: json['storageKey'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': assetId,
        'sortOrder': sortOrder,
        'assetType': assetType,
        'width': width,
        'height': height,
        'storageKey': storageKey,
      };
}

class ChapterVersionInfo {
  final String id;
  final int versionNumber;
  final String? versionType;
  final String? language;
  final bool isPublished;
  final DateTime? createdAt;

  const ChapterVersionInfo({
    required this.id,
    required this.versionNumber,
    this.versionType,
    this.language,
    this.isPublished = false,
    this.createdAt,
  });

  factory ChapterVersionInfo.fromJson(Map<String, dynamic> json) {
    return ChapterVersionInfo(
      id: json['id'] as String? ?? '',
      versionNumber: (json['versionNumber'] as num?)?.toInt() ?? 1,
      versionType: json['versionType'] as String?,
      language: json['language'] as String?,
      isPublished: json['isPublished'] as bool? ?? false,
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'versionNumber': versionNumber,
        'versionType': versionType,
        'language': language,
        'isPublished': isPublished,
        'createdAt': createdAt?.toIso8601String(),
      };
}

class ChapterNavSummary {
  final String id;
  final String chapterNumber;
  final String? title;

  const ChapterNavSummary({
    required this.id,
    required this.chapterNumber,
    this.title,
  });

  factory ChapterNavSummary.fromJson(Map<String, dynamic> json) {
    return ChapterNavSummary(
      id: json['id'] as String? ?? '',
      chapterNumber: json['chapterNumber']?.toString() ?? '',
      title: json['title'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'chapterNumber': chapterNumber,
        'title': title,
      };
}

class ChapterNavigation {
  final ChapterNavSummary? previous;
  final ChapterNavSummary? next;

  const ChapterNavigation({
    this.previous,
    this.next,
  });

  factory ChapterNavigation.fromJson(Map<String, dynamic> json) {
    return ChapterNavigation(
      previous: json['previous'] != null
          ? ChapterNavSummary.fromJson(json['previous'] as Map<String, dynamic>)
          : null,
      next: json['next'] != null
          ? ChapterNavSummary.fromJson(json['next'] as Map<String, dynamic>)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'previous': previous?.toJson(),
        'next': next?.toJson(),
      };
}

class ChapterStorySummary {
  final String id;
  final String slug;
  final String title;
  final String mediaFormat;
  final String visibility;

  const ChapterStorySummary({
    required this.id,
    required this.slug,
    required this.title,
    this.mediaFormat = 'COMIC',
    this.visibility = 'PUBLIC',
  });

  factory ChapterStorySummary.fromJson(Map<String, dynamic> json) {
    return ChapterStorySummary(
      id: json['id'] as String? ?? '',
      slug: json['slug'] as String? ?? '',
      title: json['title'] as String? ?? '',
      mediaFormat: json['mediaFormat'] as String? ?? 'COMIC',
      visibility: json['visibility'] as String? ?? 'PUBLIC',
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'slug': slug,
        'title': title,
        'mediaFormat': mediaFormat,
        'visibility': visibility,
      };
}

class ChapterHeaderSummary {
  final String id;
  final String? storyEditionId;
  final String chapterNumber;
  final String? title;
  final String? activeVersionId;
  final int viewsCount;

  const ChapterHeaderSummary({
    required this.id,
    this.storyEditionId,
    required this.chapterNumber,
    this.title,
    this.activeVersionId,
    this.viewsCount = 0,
  });

  factory ChapterHeaderSummary.fromJson(Map<String, dynamic> json) {
    return ChapterHeaderSummary(
      id: json['id'] as String? ?? '',
      storyEditionId: json['storyEditionId'] as String?,
      chapterNumber: json['chapterNumber']?.toString() ?? '1',
      title: json['title'] as String?,
      activeVersionId: json['activeVersionId'] as String?,
      viewsCount: (json['viewsCount'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'storyEditionId': storyEditionId,
        'chapterNumber': chapterNumber,
        'title': title,
        'activeVersionId': activeVersionId,
        'viewsCount': viewsCount,
      };
}

class ChapterDetail {
  final ChapterStorySummary story;
  final ChapterHeaderSummary chapter;
  final ChapterVersionInfo? activeVersion;
  final List<ChapterVersionInfo> availableVersions;
  final List<ChapterPage> pages;
  final ChapterNavigation navigation;

  const ChapterDetail({
    required this.story,
    required this.chapter,
    this.activeVersion,
    this.availableVersions = const [],
    this.pages = const [],
    this.navigation = const ChapterNavigation(),
  });

  factory ChapterDetail.fromJson(Map<String, dynamic> json) {
    final pagesRaw = (json['pages'] as List<dynamic>?) ??
        (json['mediaAssets'] as List<dynamic>?) ??
        [];

    return ChapterDetail(
      story: ChapterStorySummary.fromJson(
          json['story'] as Map<String, dynamic>? ?? {}),
      chapter: ChapterHeaderSummary.fromJson(
          json['chapter'] as Map<String, dynamic>? ?? {}),
      activeVersion: json['activeVersion'] != null
          ? ChapterVersionInfo.fromJson(
              json['activeVersion'] as Map<String, dynamic>)
          : null,
      availableVersions: (json['availableVersions'] as List<dynamic>?)
              ?.map((v) =>
                  ChapterVersionInfo.fromJson(v as Map<String, dynamic>))
              .toList() ??
          [],
      pages: pagesRaw
          .map((p) => ChapterPage.fromJson(p as Map<String, dynamic>))
          .toList(),
      navigation: json['navigation'] != null
          ? ChapterNavigation.fromJson(
              json['navigation'] as Map<String, dynamic>)
          : const ChapterNavigation(),
    );
  }

  Map<String, dynamic> toJson() => {
        'story': story.toJson(),
        'chapter': chapter.toJson(),
        'activeVersion': activeVersion?.toJson(),
        'availableVersions': availableVersions.map((v) => v.toJson()).toList(),
        'pages': pages.map((p) => p.toJson()).toList(),
        'navigation': navigation.toJson(),
      };
}

class PresignedMediaUrlResponse {
  final String assetId;
  final String downloadUrl;
  final int expiresInSeconds;

  const PresignedMediaUrlResponse({
    required this.assetId,
    required this.downloadUrl,
    required this.expiresInSeconds,
  });

  factory PresignedMediaUrlResponse.fromJson(Map<String, dynamic> json) {
    return PresignedMediaUrlResponse(
      assetId: json['assetId'] as String? ?? '',
      downloadUrl: json['downloadUrl'] as String? ?? '',
      expiresInSeconds: (json['expiresInSeconds'] as num?)?.toInt() ?? 3600,
    );
  }

  Map<String, dynamic> toJson() => {
        'assetId': assetId,
        'downloadUrl': downloadUrl,
        'expiresInSeconds': expiresInSeconds,
      };
}
