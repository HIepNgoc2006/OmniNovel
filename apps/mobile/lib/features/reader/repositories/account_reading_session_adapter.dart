import '../presentation/reading_progress_coordinator.dart';
import 'reading_session_access.dart';

/// Adapter kết nối [ReadingSessionAccess] với [ReadingProgressCoordinator] dành cho tài khoản đã xác thực.
class AccountReadingSessionAdapter implements ReadingSessionAccess {
  final ReadingProgressCoordinator _coordinator;

  AccountReadingSessionAdapter({
    required ReadingProgressCoordinator coordinator,
  }) : _coordinator = coordinator;

  @override
  Future<void> initSession({required String storyId}) async {
    await _coordinator.startSession(storyId);
  }

  @override
  void recordProgress({
    required String storyId,
    required String chapterId,
    String? chapterVersionId,
    String readingMode = 'WEBTOON',
    required int flutterPageIndex,
    required double progressPercentage,
    required double scrollPosition,
    String? anchorBlockId,
    int? textOffset,
    String? storyTitle,
    String? storySlug,
    String? storyCoverUrl,
    String? chapterNumber,
    String? chapterTitle,
  }) {
    _coordinator.recordProgress(
      storyId: storyId,
      chapterId: chapterId,
      chapterVersionId: chapterVersionId,
      readingMode: readingMode,
      flutterPageIndex: flutterPageIndex,
      progressPercentage: progressPercentage,
      scrollPosition: scrollPosition,
      anchorBlockId: anchorBlockId,
      textOffset: textOffset,
    );
  }

  @override
  Future<void> flush() async {
    _coordinator.flush();
  }

  @override
  void dispose() {
    _coordinator.dispose();
  }
}
