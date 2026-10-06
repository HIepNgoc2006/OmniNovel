import '../../../core/storage/local_library_models.dart';
import '../models/story_reading_state.dart';
import '../presentation/reading_progress_coordinator.dart';
import 'guest_reading_progress_repository.dart';
import 'reading_state_access.dart';

/// Adapter kết nối [ReadingStateAccess] với [GuestReadingProgressRepository] dành cho Khách (Guest).
/// Đọc trực tiếp từ SQLite theo partition `guest:<id>` hiện tại.
/// Cam kết: Zero network, zero epoch, zero SharedPreferences 'anon'.
class GuestReadingStateAdapter implements ReadingStateAccess {
  final GuestReadingProgressRepository _guestRepository;

  GuestReadingStateAdapter({
    required GuestReadingProgressRepository guestRepository,
  }) : _guestRepository = guestRepository;

  @override
  Future<StoryReadingState> getStoryReadingState(String storyId) async {
    final results = await Future.wait([
      _guestRepository.getProgress(storyId),
      _guestRepository.getReadChapterIds(storyId),
    ]);

    final progress = results[0] as LocalReadingProgress?;
    final readChapterIdsList = results[1] as List<String>;

    ResumePointer? resume;
    if (progress != null && progress.chapterId.isNotEmpty) {
      resume = ResumePointer(
        chapterId: progress.chapterId,
        chapterVersionId: progress.chapterVersionId,
        flutterPageIndex: (progress.pageIndex - 1).clamp(0, 99999),
        serverPageIndex: progress.pageIndex >= 1 ? progress.pageIndex : 1,
        progressPercentage: progress.progressPercentage,
        scrollPosition: progress.scrollPosition,
        anchorBlockId: progress.anchorBlockId,
        textOffset: progress.textOffset,
        isFromLocal: true,
      );
    }

    return StoryReadingState(
      resume: resume,
      readChapterIds: readChapterIdsList.toSet(),
    );
  }
}
