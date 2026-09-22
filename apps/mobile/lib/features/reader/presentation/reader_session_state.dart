import '../models/reader_models.dart';
import 'reader_window_policy.dart';

enum ReaderStatus {
  initial,
  loading,
  ready,
  error,
}

/// Trạng thái phiên đọc thuần túy (Pure Dart State Model)
class ReaderSessionState {
  final ReaderStatus status;
  final ChapterDetail? chapterDetail;
  final int visibleStartIndex;
  final int visibleEndIndex;
  final int focusedPageIndex;
  final double progressPercentage;
  final double scrollPosition;
  final ReaderWindowResult windowResult;
  final String? errorMessage;

  const ReaderSessionState({
    this.status = ReaderStatus.initial,
    this.chapterDetail,
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

  List<ChapterPage> get pages => chapterDetail?.pages ?? const [];
  int get totalPages => pages.length;

  ReaderSessionState copyWith({
    ReaderStatus? status,
    ChapterDetail? chapterDetail,
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
      chapterDetail: chapterDetail ?? this.chapterDetail,
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
