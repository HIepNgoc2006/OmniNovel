import '../models/story_reading_state.dart';

/// Port trừu tượng quản lý việc truy xuất trạng thái đọc truyện (Reading State) ở tầng UI.
/// Tách rời hoàn toàn semantics của Account (server epoch, SharedPreferences checkpoint, HTTP getProgress)
/// khỏi Guest (SQLite partition guest:<id>, zero network, zero epoch).
abstract class ReadingStateAccess {
  /// Lấy trạng thái đọc truyện trung lập UI (Resume Pointer & danh sách chương đã đọc).
  Future<StoryReadingState> getStoryReadingState(String storyId);
}
