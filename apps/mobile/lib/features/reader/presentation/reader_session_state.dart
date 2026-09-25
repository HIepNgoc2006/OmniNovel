import '../../offline/services/offline_content_resolver.dart';
import '../models/reader_models.dart';
import 'reader_window_policy.dart';

enum ReaderStatus {
  initial,
  loading,
  ready,
  error,
}

enum ReaderTransportMode {
  online,
  offline,
}

/// Trạng thái phiên đọc thuần túy (Pure Dart State Model)
class ReaderSessionState {
  final ReaderStatus status;
  final ReaderTransportMode transportMode;
  final ChapterDetail? chapterDetail;
  final ResolvedOfflineChapter? resolvedOfflineChapter;
  final int visibleStartIndex;
  final int visibleEndIndex;
  final int focusedPageIndex;
  final double progressPercentage;
  final double scrollPosition;
  final ReaderWindowResult windowResult;
  final String? errorMessage;

  const ReaderSessionState({
    this.status = ReaderStatus.initial,
    this.transportMode = ReaderTransportMode.online,
    this.chapterDetail,
    this.resolvedOfflineChapter,
    this.visibleStartIndex = 0,
    this.visibleEndIndex = 0,
    this.focusedPageIndex = 0,
    this.progressPercentage = 0.0,
    this.scrollPosition = 0.0,
    this.windowResult = const ReaderWindowResult(
      visibleIndexes: {},
      adjacentIndexes: {},
      distantIndexes: {},
    ),
    this.errorMessage,
  });

  bool get isOffline => transportMode == ReaderTransportMode.offline;
  List<ChapterPage> get pages => chapterDetail?.pages ?? const [];
  int get totalPages => pages.length;

  ReaderSessionState copyWith({
    ReaderStatus? status,
    ReaderTransportMode? transportMode,
    ChapterDetail? chapterDetail,
    ResolvedOfflineChapter? resolvedOfflineChapter,
    int? visibleStartIndex,
    int? visibleEndIndex,
    int? focusedPageIndex,
    double? progressPercentage,
    double? scrollPosition,
    ReaderWindowResult? windowResult,
    String? errorMessage,
  }) {
    return ReaderSessionState(
      status: status ?? this.status,
      transportMode: transportMode ?? this.transportMode,
      chapterDetail: chapterDetail ?? this.chapterDetail,
      resolvedOfflineChapter: resolvedOfflineChapter ?? this.resolvedOfflineChapter,
      visibleStartIndex: visibleStartIndex ?? this.visibleStartIndex,
      visibleEndIndex: visibleEndIndex ?? this.visibleEndIndex,
      focusedPageIndex: focusedPageIndex ?? this.focusedPageIndex,
      progressPercentage: progressPercentage ?? this.progressPercentage,
      scrollPosition: scrollPosition ?? this.scrollPosition,
      windowResult: windowResult ?? this.windowResult,
      errorMessage: errorMessage ?? this.errorMessage,
    );
  }
}
