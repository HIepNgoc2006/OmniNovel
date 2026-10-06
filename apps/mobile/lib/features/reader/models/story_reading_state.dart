import 'package:flutter/foundation.dart';
import '../presentation/reading_progress_coordinator.dart';

/// Neutral UI State biểu diễn trạng thái đọc của một truyện tại Story Detail.
/// Không phụ thuộc vào DTO của Server (ReadingProgressResponse) hay SQLite (LocalReadingProgress).
@immutable
class StoryReadingState {
  final ResumePointer? resume;
  final Set<String> readChapterIds;

  const StoryReadingState({
    this.resume,
    this.readChapterIds = const <String>{},
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is StoryReadingState &&
          runtimeType == other.runtimeType &&
          resume == other.resume &&
          setEquals(readChapterIds, other.readChapterIds);

  @override
  int get hashCode => Object.hash(resume, Object.hashAll(readChapterIds));
}
