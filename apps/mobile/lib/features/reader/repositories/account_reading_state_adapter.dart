import '../models/reading_progress_models.dart';
import '../models/story_reading_state.dart';
import '../presentation/reading_progress_coordinator.dart';
import 'reading_progress_repository.dart';
import 'reading_state_access.dart';

/// Adapter kết nối [ReadingStateAccess] với [ReadingProgressRepository] dành cho tài khoản đã xác thực (Account).
/// Hỗ trợ cả server progress lẫn local checkpoint SharedPreferences dự phòng.
class AccountReadingStateAdapter implements ReadingStateAccess {
  final ReadingProgressRepository _repository;

  AccountReadingStateAdapter({
    required ReadingProgressRepository repository,
  }) : _repository = repository;

  @override
  Future<StoryReadingState> getStoryReadingState(String storyId) async {
    final results = await Future.wait([
      () async {
        try {
          return await _repository.getProgress(storyId);
        } catch (_) {
          return null;
        }
      }(),
      _repository.getLocalCheckpoint(storyId),
    ]);

    final serverProgress = results[0] as ReadingProgressResponse?;
    final localCheckpoint = results[1] as LocalReadingCheckpoint?;

    // Hydrate server epoch CHỈ KHI getProgress() thành công (tránh zero-fallback)
    if (serverProgress != null) {
      _repository.setServerEpoch(storyId, serverProgress.writeEpoch);
    }

    final resume = ReadingProgressCoordinator.resolvePointer(
      local: localCheckpoint,
      server: serverProgress,
    );

    return StoryReadingState(
      resume: resume,
      readChapterIds:
          serverProgress?.readChapterIds.toSet() ?? const <String>{},
    );
  }
}
