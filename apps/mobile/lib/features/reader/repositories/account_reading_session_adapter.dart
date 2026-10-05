import '../../gamification/repositories/gamification_repository.dart';
import '../presentation/reading_progress_coordinator.dart';
import 'reading_progress_repository.dart';
import 'reading_session_access.dart';

/// Adapter kết nối [ReadingSessionAccess] với [ReadingProgressCoordinator] dành cho tài khoản đã xác thực.
class AccountReadingSessionAdapter implements ReadingSessionAccess {
  final ReadingProgressRepository? _readingProgressRepository;
  final GamificationRepository? _gamificationRepository;
  ReadingProgressCoordinator? _coordinator;

  AccountReadingSessionAdapter({
    ReadingProgressCoordinator? coordinator,
    ReadingProgressRepository? readingProgressRepository,
    GamificationRepository? gamificationRepository,
  })  : _coordinator = coordinator,
        _readingProgressRepository = readingProgressRepository,
        _gamificationRepository = gamificationRepository;

  ReadingProgressCoordinator? get coordinator => _coordinator;

  ReadingProgressCoordinator _ensureCoordinator() {
    if (_coordinator == null) {
      if (_readingProgressRepository != null) {
        _coordinator = ReadingProgressCoordinator(
          repository: _readingProgressRepository,
          gamificationRepository: _gamificationRepository,
        );
        _coordinator!.init();
      } else {
        throw StateError('Thiếu ReadingProgressRepository để khởi tạo coordinator');
      }
    }
    return _coordinator!;
  }

  @override
  Future<void> initSession({required String storyId}) async {
    final coord = _ensureCoordinator();
    await coord.startSession(storyId);
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
    final coord = _ensureCoordinator();
    coord.recordProgress(
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

  /// Hủy bỏ ngay lập tức coordinator để không tiếp tục bất kỳ HTTP mutation nào sau khi scope chuyển đổi.
  void cancelPendingEffects() {
    _coordinator?.dispose();
    _coordinator = null;
  }

  @override
  Future<void> flush() async {
    if (_coordinator != null) {
      await _coordinator!.flush();
    }
  }

  @override
  void dispose() {
    cancelPendingEffects();
  }
}
