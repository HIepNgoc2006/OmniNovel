/// Port trừu tượng quản lý Phiên Đọc (Reading Session) ở tầng UI.
/// Tách rời hoàn toàn semantics của Account (server epoch, HTTP sync)
/// khỏi Guest (SQLite atomic session, zero network).
abstract class ReadingSessionAccess {
  /// Khởi tạo phiên đọc cho một truyện.
  Future<void> initSession({required String storyId});

  /// Ghi nhận tiến độ đọc kèm metadata để lưu trữ lịch sử chính xác.
  void recordProgress({
    required String storyId,
    required String chapterId,
    String? chapterVersionId,
    String readingMode,
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
  });

  /// Đẩy ngay lập tức các thay đổi đang chờ (pending) xuống storage / server.
  Future<void> flush();

  /// Giải phóng tài nguyên của phiên đọc khi thoát màn hình.
  void dispose();
}
