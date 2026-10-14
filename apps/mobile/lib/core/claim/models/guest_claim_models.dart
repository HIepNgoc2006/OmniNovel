/// Status of a guest claim session in the durable ledger.
enum GuestClaimStatus {
  prepared('PREPARED'),
  committed('COMMITTED'),
  aborted('ABORTED'),
  expired('EXPIRED');

  final String value;
  const GuestClaimStatus(this.value);

  /// Parser nghiêm ngặt (Fail-Closed): Ném ArgumentError nếu gặp status lạ hoặc null/empty.
  static GuestClaimStatus fromStrictString(String? val) {
    if (val == null) {
      throw ArgumentError('GuestClaimStatus string cannot be null');
    }
    final upper = val.trim().toUpperCase();
    if (upper.isEmpty) {
      throw ArgumentError('GuestClaimStatus string cannot be empty');
    }
    for (final s in GuestClaimStatus.values) {
      if (s.value == upper) return s;
    }
    throw ArgumentError('Invalid or unsupported GuestClaimStatus: "$val"');
  }

  /// Parser linh hoạt hỗ trợ fallback về prepared khi cần thiết cho backward compatibility.
  static GuestClaimStatus fromString(String? val) {
    if (val == null) return GuestClaimStatus.prepared;
    final upper = val.trim().toUpperCase();
    for (final s in GuestClaimStatus.values) {
      if (s.value == upper) return s;
    }
    return GuestClaimStatus.prepared;
  }
}

/// User resolution choice for progress conflict tuples.
enum ConflictResolution {
  keepCloud('KEEP_CLOUD'),
  useGuest('USE_GUEST');

  final String value;
  const ConflictResolution(this.value);

  static ConflictResolution fromString(String? val) {
    if (val == null) return ConflictResolution.keepCloud;
    final upper = val.trim().toUpperCase();
    for (final r in ConflictResolution.values) {
      if (r.value == upper) return r;
    }
    return ConflictResolution.keepCloud;
  }
}

/// Canonical reading modes allowed by backend Core API.
///
/// Invariant 13: Canonical reading modes are strictly 'WEBTOON' | 'PAGED' | 'NOVEL'.
/// Any local/legacy 'MANGA_PAGED' value is automatically normalized to 'PAGED'.
enum ReadingMode {
  webtoon('WEBTOON'),
  paged('PAGED'),
  novel('NOVEL');

  final String value;
  const ReadingMode(this.value);

  static ReadingMode fromString(String? val) {
    if (val == null) return ReadingMode.webtoon;
    final normalized = val.trim().toUpperCase();
    if (normalized == 'MANGA_PAGED' || normalized == 'PAGED') {
      return ReadingMode.paged;
    }
    if (normalized == 'NOVEL') {
      return ReadingMode.novel;
    }
    return ReadingMode.webtoon;
  }
}

/// Minimal bookmark entry from guest local storage.
class GuestBookmarkItem {
  final String storyId;
  final String? createdAt;

  const GuestBookmarkItem({
    required this.storyId,
    this.createdAt,
  });

  factory GuestBookmarkItem.fromJson(Map<String, dynamic> json) {
    return GuestBookmarkItem(
      storyId: json['storyId'] as String,
      createdAt: json['createdAt'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'storyId': storyId,
        if (createdAt != null) 'createdAt': createdAt,
      };
}

/// Chapter read state entry from guest local history.
class GuestHistoryItem {
  final String storyId;
  final String chapterId;
  final double progressPercentage;
  final String? completedAt;
  final String? lastReadAt;

  const GuestHistoryItem({
    required this.storyId,
    required this.chapterId,
    required this.progressPercentage,
    this.completedAt,
    this.lastReadAt,
  });

  factory GuestHistoryItem.fromJson(Map<String, dynamic> json) {
    return GuestHistoryItem(
      storyId: json['storyId'] as String,
      chapterId: json['chapterId'] as String,
      progressPercentage: (json['progressPercentage'] as num?)?.toDouble() ?? 0.0,
      completedAt: json['completedAt'] as String?,
      lastReadAt: json['lastReadAt'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'storyId': storyId,
        'chapterId': chapterId,
        'progressPercentage': progressPercentage,
        if (completedAt != null) 'completedAt': completedAt,
        if (lastReadAt != null) 'lastReadAt': lastReadAt,
      };
}

/// Canonical 7-tuple reading progress entry.
class GuestProgressItem {
  final String storyId;
  final String chapterId;
  final String? chapterVersionId;
  final ReadingMode readingMode;
  final int pageIndex;
  final double scrollPosition;
  final double progressPercentage;
  final String? anchorBlockId;
  final int? textOffset;
  final String? updatedAt;

  GuestProgressItem({
    required this.storyId,
    required this.chapterId,
    this.chapterVersionId,
    required this.readingMode,
    required int pageIndex,
    required this.scrollPosition,
    required this.progressPercentage,
    this.anchorBlockId,
    this.textOffset,
    this.updatedAt,
  }) : pageIndex = pageIndex < 1 ? 1 : pageIndex; // Bound check: 1-based >= 1

  /// Đảm bảo pageIndex luôn >= 1 theo chuẩn canonical (1-based index)
  int get safePageIndex => pageIndex < 1 ? 1 : pageIndex;

  factory GuestProgressItem.fromJson(Map<String, dynamic> json) {
    final rawPageIndex = json['pageIndex'] is num ? (json['pageIndex'] as num).toInt() : 1;
    return GuestProgressItem(
      storyId: json['storyId'] as String,
      chapterId: json['chapterId'] as String,
      chapterVersionId: json['chapterVersionId'] as String?,
      readingMode: ReadingMode.fromString(json['readingMode'] as String?),
      pageIndex: rawPageIndex < 1 ? 1 : rawPageIndex,
      scrollPosition: (json['scrollPosition'] as num?)?.toDouble() ?? 0.0,
      progressPercentage: (json['progressPercentage'] as num?)?.toDouble() ?? 0.0,
      anchorBlockId: json['anchorBlockId'] as String?,
      textOffset: json['textOffset'] is num ? (json['textOffset'] as num).toInt() : null,
      updatedAt: json['updatedAt'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'storyId': storyId,
        'chapterId': chapterId,
        if (chapterVersionId != null) 'chapterVersionId': chapterVersionId,
        'readingMode': readingMode.value,
        'pageIndex': pageIndex,
        'scrollPosition': scrollPosition,
        'progressPercentage': progressPercentage,
        if (anchorBlockId != null) 'anchorBlockId': anchorBlockId,
        if (textOffset != null) 'textOffset': textOffset,
        if (updatedAt != null) 'updatedAt': updatedAt,
      };
}

/// Payload sent to POST /api/v1/account/guest-claims/prepare.
class PrepareGuestClaimPayload {
  final String guestProfileId;
  final List<GuestBookmarkItem> bookmarks;
  final List<GuestHistoryItem> history;
  final List<GuestProgressItem> progress;

  const PrepareGuestClaimPayload({
    required this.guestProfileId,
    this.bookmarks = const [],
    this.history = const [],
    this.progress = const [],
  });

  factory PrepareGuestClaimPayload.fromJson(Map<String, dynamic> json) {
    return PrepareGuestClaimPayload(
      guestProfileId: json['guestProfileId'] as String,
      bookmarks: (json['bookmarks'] as List<dynamic>?)
              ?.map((e) => GuestBookmarkItem.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      history: (json['history'] as List<dynamic>?)
              ?.map((e) => GuestHistoryItem.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      progress: (json['progress'] as List<dynamic>?)
              ?.map((e) => GuestProgressItem.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
    );
  }

  Map<String, dynamic> toJson() => {
        'guestProfileId': guestProfileId,
        'bookmarks': bookmarks.map((e) => e.toJson()).toList(),
        'history': history.map((e) => e.toJson()).toList(),
        'progress': progress.map((e) => e.toJson()).toList(),
      };
}

/// Conflict details returned when cloud and guest progress differ.
class ReadingProgressConflict {
  final String storyId;
  final GuestProgressItem cloudProgress;
  final GuestProgressItem guestProgress;

  const ReadingProgressConflict({
    required this.storyId,
    required this.cloudProgress,
    required this.guestProgress,
  });

  factory ReadingProgressConflict.fromJson(Map<String, dynamic> json) {
    return ReadingProgressConflict(
      storyId: json['storyId'] as String,
      cloudProgress: GuestProgressItem.fromJson(json['cloudProgress'] as Map<String, dynamic>),
      guestProgress: GuestProgressItem.fromJson(json['guestProgress'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() => {
        'storyId': storyId,
        'cloudProgress': cloudProgress.toJson(),
        'guestProgress': guestProgress.toJson(),
      };
}

/// Response returned from POST /api/v1/account/guest-claims/prepare.
class GuestClaimPreviewResult {
  final String claimId;
  final GuestClaimStatus status;
  final String stateFingerprint;
  final String expiresAt;
  final int bookmarksToImport;
  final int historyToImport;
  final int progressToImport;
  final int conflictsCount;
  final int readStatesIgnoredAntiResurrectionCount;
  final List<ReadingProgressConflict> conflicts;

  const GuestClaimPreviewResult({
    required this.claimId,
    required this.status,
    required this.stateFingerprint,
    required this.expiresAt,
    required this.bookmarksToImport,
    required this.historyToImport,
    required this.progressToImport,
    required this.conflictsCount,
    required this.readStatesIgnoredAntiResurrectionCount,
    this.conflicts = const [],
  });

  factory GuestClaimPreviewResult.fromJson(Map<String, dynamic> json) {
    return GuestClaimPreviewResult(
      claimId: json['claimId'] as String,
      status: GuestClaimStatus.fromStrictString(json['status'] as String?),
      stateFingerprint: json['stateFingerprint'] as String? ?? '',
      expiresAt: json['expiresAt'] as String? ?? '',
      bookmarksToImport: (json['bookmarksToImport'] as num?)?.toInt() ?? 0,
      historyToImport: (json['historyToImport'] as num?)?.toInt() ?? 0,
      progressToImport: (json['progressToImport'] as num?)?.toInt() ?? 0,
      conflictsCount: (json['conflictsCount'] as num?)?.toInt() ?? 0,
      readStatesIgnoredAntiResurrectionCount:
          (json['readStatesIgnoredAntiResurrectionCount'] as num?)?.toInt() ?? 0,
      conflicts: (json['conflicts'] as List<dynamic>?)
              ?.map((e) => ReadingProgressConflict.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
    );
  }

  Map<String, dynamic> toJson() => {
        'claimId': claimId,
        'status': status.value,
        'stateFingerprint': stateFingerprint,
        'expiresAt': expiresAt,
        'bookmarksToImport': bookmarksToImport,
        'historyToImport': historyToImport,
        'progressToImport': progressToImport,
        'conflictsCount': conflictsCount,
        'readStatesIgnoredAntiResurrectionCount': readStatesIgnoredAntiResurrectionCount,
        'conflicts': conflicts.map((e) => e.toJson()).toList(),
      };
}

/// Payload sent to POST /api/v1/account/guest-claims/:claimId/commit.
class CommitGuestClaimPayload {
  static final RegExp _fingerprintRegex = RegExp(r'^[a-fA-F0-9]{64}$');

  final String expectedStateFingerprint;
  final Map<String, ConflictResolution> conflictDecisions;

  const CommitGuestClaimPayload({
    this.expectedStateFingerprint = '',
    this.conflictDecisions = const {},
  });

  /// Factory constructor xác thực chặt chẽ (fail-closed) trước khi dispatch request POST /commit.
  factory CommitGuestClaimPayload.validated({
    required String expectedStateFingerprint,
    Map<String, ConflictResolution> conflictDecisions = const {},
  }) {
    final trimmed = expectedStateFingerprint.trim();
    if (trimmed.isEmpty || !_fingerprintRegex.hasMatch(trimmed)) {
      throw ArgumentError(
        'expectedStateFingerprint must be a valid 64-character hexadecimal SHA-256 string, got: "$expectedStateFingerprint"',
      );
    }
    return CommitGuestClaimPayload(
      expectedStateFingerprint: trimmed,
      conflictDecisions: conflictDecisions,
    );
  }

  factory CommitGuestClaimPayload.fromJson(Map<String, dynamic> json) {
    final decisions = <String, ConflictResolution>{};
    if (json['conflictDecisions'] is Map<String, dynamic>) {
      (json['conflictDecisions'] as Map<String, dynamic>).forEach((key, value) {
        decisions[key] = ConflictResolution.fromString(value?.toString());
      });
    }
    return CommitGuestClaimPayload(
      expectedStateFingerprint:
          json['expectedStateFingerprint']?.toString() ?? '',
      conflictDecisions: decisions,
    );
  }

  Map<String, dynamic> toJson() => {
        'expectedStateFingerprint': expectedStateFingerprint,
        'conflictDecisions':
            conflictDecisions.map((k, v) => MapEntry(k, v.value)),
      };
}

/// Statistics summary for a committed claim.
class GuestClaimCommitSummary {
  final int bookmarksImported;
  final int historyMerged;
  final int progressUpdated;
  final int conflictsResolved;

  const GuestClaimCommitSummary({
    required this.bookmarksImported,
    required this.historyMerged,
    required this.progressUpdated,
    required this.conflictsResolved,
  });

  factory GuestClaimCommitSummary.fromJson(Map<String, dynamic> json) {
    return GuestClaimCommitSummary(
      bookmarksImported: (json['bookmarksImported'] as num?)?.toInt() ?? 0,
      historyMerged: (json['historyMerged'] as num?)?.toInt() ?? 0,
      progressUpdated: (json['progressUpdated'] as num?)?.toInt() ?? 0,
      conflictsResolved: (json['conflictsResolved'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'bookmarksImported': bookmarksImported,
        'historyMerged': historyMerged,
        'progressUpdated': progressUpdated,
        'conflictsResolved': conflictsResolved,
      };
}

/// Response returned from POST /api/v1/account/guest-claims/:claimId/commit.
class GuestClaimCommitResult {
  final String claimId;
  final GuestClaimStatus status;
  final String committedAt;
  final GuestClaimCommitSummary summary;

  const GuestClaimCommitResult({
    required this.claimId,
    required this.status,
    required this.committedAt,
    required this.summary,
  });

  factory GuestClaimCommitResult.fromJson(Map<String, dynamic> json) {
    return GuestClaimCommitResult(
      claimId: json['claimId'] as String,
      status: GuestClaimStatus.fromStrictString(json['status'] as String?),
      committedAt: json['committedAt'] as String? ?? '',
      summary: GuestClaimCommitSummary.fromJson(
        json['summary'] as Map<String, dynamic>? ?? const {},
      ),
    );
  }

  Map<String, dynamic> toJson() => {
        'claimId': claimId,
        'status': status.value,
        'committedAt': committedAt,
        'summary': summary.toJson(),
      };
}

/// Response returned from GET /api/v1/account/guest-claims/:claimId/status.
class GuestClaimStatusResult {
  final String claimId;
  final GuestClaimStatus status;
  final String expiresAt;
  final String? committedAt;
  final GuestClaimPreviewResult previewData;
  final GuestClaimCommitSummary? resultSummary;

  const GuestClaimStatusResult({
    required this.claimId,
    required this.status,
    required this.expiresAt,
    this.committedAt,
    required this.previewData,
    this.resultSummary,
  });

  factory GuestClaimStatusResult.fromJson(Map<String, dynamic> json) {
    return GuestClaimStatusResult(
      claimId: json['claimId'] as String,
      status: GuestClaimStatus.fromStrictString(json['status'] as String?),
      expiresAt: json['expiresAt'] as String? ?? '',
      committedAt: json['committedAt'] as String?,
      previewData: GuestClaimPreviewResult.fromJson(
        json['previewData'] as Map<String, dynamic>? ?? const {},
      ),
      resultSummary: json['resultSummary'] != null
          ? GuestClaimCommitSummary.fromJson(
              json['resultSummary'] as Map<String, dynamic>,
            )
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'claimId': claimId,
        'status': status.value,
        'expiresAt': expiresAt,
        if (committedAt != null) 'committedAt': committedAt,
        'previewData': previewData.toJson(),
        if (resultSummary != null) 'resultSummary': resultSummary!.toJson(),
      };
}
