enum TranslationJobStatus {
  pending,
  processing,
  failed,
  readyForReview,
  applied,
  canceled,
  expired;

  static TranslationJobStatus fromString(String? value) {
    switch (value?.toUpperCase()) {
      case 'PENDING':
        return TranslationJobStatus.pending;
      case 'PROCESSING':
        return TranslationJobStatus.processing;
      case 'FAILED':
        return TranslationJobStatus.failed;
      case 'READY_FOR_REVIEW':
        return TranslationJobStatus.readyForReview;
      case 'APPLIED':
        return TranslationJobStatus.applied;
      case 'CANCELED':
        return TranslationJobStatus.canceled;
      case 'EXPIRED':
        return TranslationJobStatus.expired;
      default:
        return TranslationJobStatus.pending;
    }
  }

  String toServerString() {
    switch (this) {
      case TranslationJobStatus.pending:
        return 'PENDING';
      case TranslationJobStatus.processing:
        return 'PROCESSING';
      case TranslationJobStatus.failed:
        return 'FAILED';
      case TranslationJobStatus.readyForReview:
        return 'READY_FOR_REVIEW';
      case TranslationJobStatus.applied:
        return 'APPLIED';
      case TranslationJobStatus.canceled:
        return 'CANCELED';
      case TranslationJobStatus.expired:
        return 'EXPIRED';
    }
  }
}

enum MediaFormat {
  comic,
  novel;

  static MediaFormat fromString(String? value) {
    switch (value?.toUpperCase()) {
      case 'COMIC':
        return MediaFormat.comic;
      case 'NOVEL':
        return MediaFormat.novel;
      default:
        return MediaFormat.comic;
    }
  }

  String toServerString() {
    switch (this) {
      case MediaFormat.comic:
        return 'COMIC';
      case MediaFormat.novel:
        return 'NOVEL';
    }
  }
}

enum ApplyTranslationMode {
  overwriteActiveVersion,
  createAlternateVersion;

  static ApplyTranslationMode fromString(String? value) {
    switch (value) {
      case 'OVERWRITE_ACTIVE_VERSION':
        return ApplyTranslationMode.overwriteActiveVersion;
      case 'CREATE_ALTERNATE_VERSION':
        return ApplyTranslationMode.createAlternateVersion;
      default:
        throw ArgumentError('Unknown ApplyTranslationMode: $value');
    }
  }

  String toServerString() {
    switch (this) {
      case ApplyTranslationMode.overwriteActiveVersion:
        return 'OVERWRITE_ACTIVE_VERSION';
      case ApplyTranslationMode.createAlternateVersion:
        return 'CREATE_ALTERNATE_VERSION';
    }
  }
}

class ReviewSummaryDto {
  final int segmentCount;
  final int verifiedCount;
  final int? pageCount;
  final int? resultPageCount;
  final int? blockCount;

  const ReviewSummaryDto({
    required this.segmentCount,
    required this.verifiedCount,
    this.pageCount,
    this.resultPageCount,
    this.blockCount,
  });

  factory ReviewSummaryDto.fromJson(Map<String, dynamic> json) {
    return ReviewSummaryDto(
      segmentCount: (json['segmentCount'] as num?)?.toInt() ?? 0,
      verifiedCount: (json['verifiedCount'] as num?)?.toInt() ?? 0,
      pageCount: (json['pageCount'] as num?)?.toInt(),
      resultPageCount: (json['resultPageCount'] as num?)?.toInt(),
      blockCount: (json['blockCount'] as num?)?.toInt(),
    );
  }
}

class JobPermissions {
  final bool canApply;
  final String? applyBlockReason;

  const JobPermissions({
    required this.canApply,
    this.applyBlockReason,
  });

  factory JobPermissions.fromJson(Map<String, dynamic> json) {
    return JobPermissions(
      canApply: json['canApply'] as bool? ?? false,
      applyBlockReason: json['applyBlockReason'] as String?,
    );
  }
}

class JobMetadata {
  final String id;
  final TranslationJobStatus status;
  final int progressPercentage;
  final String provider;
  final String modelName;
  final String promptVersion;
  final int attemptCount;
  final int maxAttempts;
  final DateTime createdAt;
  final DateTime? startedAt;
  final DateTime? heartbeatAt;
  final DateTime? completedAt;
  final DateTime? expiresAt;
  final int reviewRevision;
  final int materializedRevision;
  final int workspaceRevision;

  const JobMetadata({
    required this.id,
    required this.status,
    required this.progressPercentage,
    required this.provider,
    required this.modelName,
    required this.promptVersion,
    required this.attemptCount,
    required this.maxAttempts,
    required this.createdAt,
    this.startedAt,
    this.heartbeatAt,
    this.completedAt,
    this.expiresAt,
    required this.reviewRevision,
    required this.materializedRevision,
    required this.workspaceRevision,
  });

  factory JobMetadata.fromJson(Map<String, dynamic> json) {
    return JobMetadata(
      id: json['id'] as String? ?? '',
      status: TranslationJobStatus.fromString(json['status'] as String?),
      progressPercentage: (json['progressPercentage'] as num?)?.toInt() ?? 0,
      provider: json['provider'] as String? ?? '',
      modelName: json['modelName'] as String? ?? '',
      promptVersion: json['promptVersion'] as String? ?? '',
      attemptCount: (json['attemptCount'] as num?)?.toInt() ?? 0,
      maxAttempts: (json['maxAttempts'] as num?)?.toInt() ?? 0,
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.now(),
      startedAt: json['startedAt'] != null ? DateTime.tryParse(json['startedAt'] as String) : null,
      heartbeatAt: json['heartbeatAt'] != null ? DateTime.tryParse(json['heartbeatAt'] as String) : null,
      completedAt: json['completedAt'] != null ? DateTime.tryParse(json['completedAt'] as String) : null,
      expiresAt: json['expiresAt'] != null ? DateTime.tryParse(json['expiresAt'] as String) : null,
      reviewRevision: (json['reviewRevision'] as num?)?.toInt() ?? 0,
      materializedRevision: (json['materializedRevision'] as num?)?.toInt() ?? 0,
      workspaceRevision: (json['workspaceRevision'] as num?)?.toInt() ?? 0,
    );
  }
}

class StoryContext {
  final String id;
  final String title;
  final String slug;
  final MediaFormat mediaFormat;

  const StoryContext({
    required this.id,
    required this.title,
    required this.slug,
    required this.mediaFormat,
  });

  factory StoryContext.fromJson(Map<String, dynamic> json) {
    return StoryContext(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      slug: json['slug'] as String? ?? '',
      mediaFormat: MediaFormat.fromString(json['mediaFormat'] as String?),
    );
  }
}

class EditionContext {
  final String id;
  final String editionName;
  final String language;
  final bool isDefault;

  const EditionContext({
    required this.id,
    required this.editionName,
    required this.language,
    required this.isDefault,
  });

  factory EditionContext.fromJson(Map<String, dynamic> json) {
    return EditionContext(
      id: json['id'] as String? ?? '',
      editionName: json['editionName'] as String? ?? '',
      language: json['language'] as String? ?? '',
      isDefault: json['isDefault'] as bool? ?? false,
    );
  }
}

class ChapterContext {
  final String id;
  final String chapterNumber;
  final String? title;

  const ChapterContext({
    required this.id,
    required this.chapterNumber,
    this.title,
  });

  factory ChapterContext.fromJson(Map<String, dynamic> json) {
    return ChapterContext(
      id: json['id'] as String? ?? '',
      chapterNumber: json['chapterNumber']?.toString() ?? '',
      title: json['title'] as String?,
    );
  }
}

class ProjectContext {
  final String id;
  final String sourceLanguage;
  final String targetLanguage;

  const ProjectContext({
    required this.id,
    required this.sourceLanguage,
    required this.targetLanguage,
  });

  factory ProjectContext.fromJson(Map<String, dynamic> json) {
    return ProjectContext(
      id: json['id'] as String? ?? '',
      sourceLanguage: json['sourceLanguage'] as String? ?? '',
      targetLanguage: json['targetLanguage'] as String? ?? '',
    );
  }
}

class VersionContext {
  final String id;
  final int versionNumber;

  const VersionContext({
    required this.id,
    required this.versionNumber,
  });

  factory VersionContext.fromJson(Map<String, dynamic> json) {
    return VersionContext(
      id: json['id'] as String? ?? '',
      versionNumber: (json['versionNumber'] as num?)?.toInt() ?? 1,
    );
  }
}

class TranslationJobContext {
  final StoryContext story;
  final EditionContext edition;
  final ChapterContext chapter;
  final ProjectContext project;
  final VersionContext sourceVersion;
  final VersionContext? targetVersion;

  const TranslationJobContext({
    required this.story,
    required this.edition,
    required this.chapter,
    required this.project,
    required this.sourceVersion,
    this.targetVersion,
  });

  factory TranslationJobContext.fromJson(Map<String, dynamic> json) {
    return TranslationJobContext(
      story: StoryContext.fromJson(json['story'] as Map<String, dynamic>? ?? {}),
      edition: EditionContext.fromJson(json['edition'] as Map<String, dynamic>? ?? {}),
      chapter: ChapterContext.fromJson(json['chapter'] as Map<String, dynamic>? ?? {}),
      project: ProjectContext.fromJson(json['project'] as Map<String, dynamic>? ?? {}),
      sourceVersion: VersionContext.fromJson(json['sourceVersion'] as Map<String, dynamic>? ?? {}),
      targetVersion: json['targetVersion'] != null
          ? VersionContext.fromJson(json['targetVersion'] as Map<String, dynamic>)
          : null,
    );
  }
}

class GlossaryTerm {
  final String sourceTerm;
  final String targetTerm;
  final String category;

  const GlossaryTerm({
    required this.sourceTerm,
    required this.targetTerm,
    required this.category,
  });

  factory GlossaryTerm.fromJson(Map<String, dynamic> json) {
    return GlossaryTerm(
      sourceTerm: json['sourceTerm'] as String? ?? '',
      targetTerm: json['targetTerm'] as String? ?? '',
      category: json['category'] as String? ?? '',
    );
  }
}

class JobErrorSummary {
  final String code;
  final String message;

  const JobErrorSummary({
    required this.code,
    required this.message,
  });

  factory JobErrorSummary.fromJson(Map<String, dynamic> json) {
    return JobErrorSummary(
      code: json['code'] as String? ?? '',
      message: json['message'] as String? ?? '',
    );
  }
}

class TranslationJobReviewDetailResponse {
  final JobMetadata job;
  final TranslationJobContext context;
  final ReviewSummaryDto reviewSummary;
  final JobPermissions permissions;
  final List<GlossaryTerm>? glossarySnapshot;
  final JobErrorSummary? error;

  const TranslationJobReviewDetailResponse({
    required this.job,
    required this.context,
    required this.reviewSummary,
    required this.permissions,
    this.glossarySnapshot,
    this.error,
  });

  /// Canonical Freshness Gate (Gate 4 Hardening):
  /// Client tính toán độ tươi mới; chỉ fresh khi reviewRevision khớp materializedRevision.
  bool get isFresh => job.reviewRevision == job.materializedRevision;

  factory TranslationJobReviewDetailResponse.fromJson(Map<String, dynamic> json) {
    final glossaryList = json['glossarySnapshot'] as List<dynamic>?;
    return TranslationJobReviewDetailResponse(
      job: JobMetadata.fromJson(json['job'] as Map<String, dynamic>? ?? {}),
      context: TranslationJobContext.fromJson(json['context'] as Map<String, dynamic>? ?? {}),
      reviewSummary: ReviewSummaryDto.fromJson(json['reviewSummary'] as Map<String, dynamic>? ?? {}),
      permissions: JobPermissions.fromJson(json['permissions'] as Map<String, dynamic>? ?? {}),
      glossarySnapshot: glossaryList
          ?.map((item) => GlossaryTerm.fromJson(item as Map<String, dynamic>))
          .toList(),
      error: json['error'] != null
          ? JobErrorSummary.fromJson(json['error'] as Map<String, dynamic>)
          : null,
    );
  }
}

class ReviewAssetDto {
  final String kind; // 'SOURCE_MEDIA' | 'SOURCE_REVIEW' | 'RESULT'
  final String? id;
  final int pageNumber;
  final int? width;
  final int? height;
  final String url;
  final int? fileSizeBytes;

  const ReviewAssetDto({
    required this.kind,
    this.id,
    required this.pageNumber,
    this.width,
    this.height,
    required this.url,
    this.fileSizeBytes,
  });

  factory ReviewAssetDto.fromJson(Map<String, dynamic> json) {
    return ReviewAssetDto(
      kind: json['kind'] as String? ?? '',
      id: json['id'] as String?,
      pageNumber: (json['pageNumber'] as num?)?.toInt() ?? 0,
      width: (json['width'] as num?)?.toInt(),
      height: (json['height'] as num?)?.toInt(),
      url: json['url'] as String? ?? '',
      fileSizeBytes: (json['fileSizeBytes'] as num?)?.toInt(),
    );
  }
}

class TranslationJobPreviewsResponse {
  final int workspaceRevision;
  final List<ReviewAssetDto> sourceAssets;
  final List<ReviewAssetDto> resultAssets;

  const TranslationJobPreviewsResponse({
    required this.workspaceRevision,
    required this.sourceAssets,
    required this.resultAssets,
  });

  factory TranslationJobPreviewsResponse.fromJson(Map<String, dynamic> json) {
    final sourceList = json['sourceAssets'] as List<dynamic>? ?? [];
    final resultList = json['resultAssets'] as List<dynamic>? ?? [];
    return TranslationJobPreviewsResponse(
      workspaceRevision: (json['workspaceRevision'] as num?)?.toInt() ?? 0,
      sourceAssets: sourceList
          .map((item) => ReviewAssetDto.fromJson(item as Map<String, dynamic>))
          .toList(),
      resultAssets: resultList
          .map((item) => ReviewAssetDto.fromJson(item as Map<String, dynamic>))
          .toList(),
    );
  }
}

class TranslationSegmentDto {
  final String id;
  final String jobId;
  final int? pageNumber;
  final String? anchorBlockId;
  final int sortOrder;
  final double? bboxX;
  final double? bboxY;
  final double? bboxW;
  final double? bboxH;
  final String rawText;
  final String? translatedText;
  final double? confidence;
  final bool isHumanVerified;
  final String? blockType;
  final int version;

  const TranslationSegmentDto({
    required this.id,
    required this.jobId,
    this.pageNumber,
    this.anchorBlockId,
    required this.sortOrder,
    this.bboxX,
    this.bboxY,
    this.bboxW,
    this.bboxH,
    required this.rawText,
    this.translatedText,
    this.confidence,
    required this.isHumanVerified,
    this.blockType,
    required this.version,
  });

  factory TranslationSegmentDto.fromJson(Map<String, dynamic> json) {
    return TranslationSegmentDto(
      id: json['id'] as String? ?? '',
      jobId: json['jobId'] as String? ?? '',
      pageNumber: (json['pageNumber'] as num?)?.toInt(),
      anchorBlockId: json['anchorBlockId'] as String?,
      sortOrder: (json['sortOrder'] as num?)?.toInt() ?? 0,
      bboxX: (json['bboxX'] as num?)?.toDouble(),
      bboxY: (json['bboxY'] as num?)?.toDouble(),
      bboxW: (json['bboxW'] as num?)?.toDouble(),
      bboxH: (json['bboxH'] as num?)?.toDouble(),
      rawText: json['rawText'] as String? ?? '',
      translatedText: json['translatedText'] as String?,
      confidence: (json['confidence'] as num?)?.toDouble(),
      isHumanVerified: json['isHumanVerified'] as bool? ?? false,
      blockType: json['blockType'] as String?,
      version: (json['version'] as num?)?.toInt() ?? 1,
    );
  }
}

class TranslationJobSegmentsResponse {
  final List<TranslationSegmentDto> data;
  final int total;
  final int page;
  final int limit;
  final int totalPages;
  final int workspaceRevision;

  const TranslationJobSegmentsResponse({
    required this.data,
    required this.total,
    required this.page,
    required this.limit,
    required this.totalPages,
    required this.workspaceRevision,
  });

  factory TranslationJobSegmentsResponse.fromJson(Map<String, dynamic> json) {
    final list = json['data'] as List<dynamic>? ?? [];
    return TranslationJobSegmentsResponse(
      data: list
          .map((item) => TranslationSegmentDto.fromJson(item as Map<String, dynamic>))
          .toList(),
      total: (json['total'] as num?)?.toInt() ?? 0,
      page: (json['page'] as num?)?.toInt() ?? 1,
      limit: (json['limit'] as num?)?.toInt() ?? 50,
      totalPages: (json['totalPages'] as num?)?.toInt() ?? 1,
      workspaceRevision: (json['workspaceRevision'] as num?)?.toInt() ?? 0,
    );
  }
}

class ApplyTranslationJobRequest {
  final ApplyTranslationMode mode;

  const ApplyTranslationJobRequest({
    required this.mode,
  });

  Map<String, dynamic> toJson() => {
        'mode': mode.toServerString(),
      };
}

class ApplyTranslationJobResponse {
  final String chapterId;
  final String? activeVersionId;
  final String targetVersionId;
  final int versionNumber;
  final String versionType;
  final bool isAlreadyApplied;

  const ApplyTranslationJobResponse({
    required this.chapterId,
    this.activeVersionId,
    required this.targetVersionId,
    required this.versionNumber,
    required this.versionType,
    required this.isAlreadyApplied,
  });

  factory ApplyTranslationJobResponse.fromJson(Map<String, dynamic> json) {
    return ApplyTranslationJobResponse(
      chapterId: json['chapterId'] as String? ?? '',
      activeVersionId: json['activeVersionId'] as String?,
      targetVersionId: json['targetVersionId'] as String? ?? '',
      versionNumber: (json['versionNumber'] as num?)?.toInt() ?? 1,
      versionType: json['versionType'] as String? ?? '',
      isAlreadyApplied: json['isAlreadyApplied'] as bool? ?? false,
    );
  }
}

class TranslationJobSummaryDto {
  final String id;
  final String? projectId;
  final String? storyId;
  final String? storyTitle;
  final String? storySlug;
  final MediaFormat? mediaFormat;
  final String? storyEditionId;
  final String? editionName;
  final String? chapterId;
  final String? chapterNumber;
  final TranslationJobStatus status;
  final String? targetLanguage;
  final String? modelName;
  final DateTime? createdAt;
  final DateTime? completedAt;

  const TranslationJobSummaryDto({
    required this.id,
    this.projectId,
    this.storyId,
    this.storyTitle,
    this.storySlug,
    this.mediaFormat,
    this.storyEditionId,
    this.editionName,
    this.chapterId,
    this.chapterNumber,
    required this.status,
    this.targetLanguage,
    this.modelName,
    this.createdAt,
    this.completedAt,
  });

  factory TranslationJobSummaryDto.fromJson(Map<String, dynamic> json) {
    return TranslationJobSummaryDto(
      id: json['id'] as String? ?? '',
      projectId: json['projectId'] as String?,
      storyId: json['storyId'] as String?,
      storyTitle: json['storyTitle'] as String?,
      storySlug: json['storySlug'] as String?,
      mediaFormat: json['mediaFormat'] != null
          ? MediaFormat.fromString(json['mediaFormat'] as String)
          : null,
      storyEditionId: json['storyEditionId'] as String?,
      editionName: json['editionName'] as String?,
      chapterId: json['chapterId'] as String?,
      chapterNumber: json['chapterNumber']?.toString(),
      status: TranslationJobStatus.fromString(json['status'] as String?),
      targetLanguage: json['targetLanguage'] as String?,
      modelName: json['modelName'] as String?,
      createdAt: json['createdAt'] != null ? DateTime.tryParse(json['createdAt'] as String) : null,
      completedAt: json['completedAt'] != null ? DateTime.tryParse(json['completedAt'] as String) : null,
    );
  }
}

class PaginatedTranslationJobsResponse {
  final List<TranslationJobSummaryDto> data;
  final int total;
  final int page;
  final int limit;
  final int totalPages;

  const PaginatedTranslationJobsResponse({
    required this.data,
    required this.total,
    required this.page,
    required this.limit,
    required this.totalPages,
  });

  factory PaginatedTranslationJobsResponse.fromJson(Map<String, dynamic> json) {
    final list = json['data'] as List<dynamic>? ?? [];
    return PaginatedTranslationJobsResponse(
      data: list
          .map((item) => TranslationJobSummaryDto.fromJson(item as Map<String, dynamic>))
          .toList(),
      total: (json['total'] as num?)?.toInt() ?? 0,
      page: (json['page'] as num?)?.toInt() ?? 1,
      limit: (json['limit'] as num?)?.toInt() ?? 20,
      totalPages: (json['totalPages'] as num?)?.toInt() ?? 1,
    );
  }
}
