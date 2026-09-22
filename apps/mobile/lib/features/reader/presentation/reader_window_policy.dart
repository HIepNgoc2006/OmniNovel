/// Pure Dart Policy quản lý 3 vùng bộ nhớ cho Webtoon Reader:
/// 1. VISIBLE: Vùng trang đang hiển thị trên màn hình người đọc.
/// 2. ADJACENT: Vùng trang lân cận (mặc định radius = 2) cần prefetch network/signed URL & bitmap.
/// 3. DISTANT: Vùng trang cách xa viewport cần evict khỏi RAM (chỉ giữ placeholder kích thước).
class ReaderWindowPolicy {
  final int totalPageCount;
  final int adjacentRadius;

  const ReaderWindowPolicy({
    required this.totalPageCount,
    this.adjacentRadius = 2,
  });

  /// Tính toán 3 phân vùng bộ nhớ dựa trên dải trang đang nhìn thấy (start..end)
  ReaderWindowResult calculateWindow({
    required int visibleStartIndex,
    required int visibleEndIndex,
  }) {
    if (totalPageCount <= 0) {
      return const ReaderWindowResult(
        visibleIndexes: {},
        adjacentIndexes: {},
        distantIndexes: {},
      );
    }

    final clampedStart = visibleStartIndex.clamp(0, totalPageCount - 1);
    final clampedEnd = visibleEndIndex.clamp(0, totalPageCount - 1);
    final actualStart = clampedStart <= clampedEnd ? clampedStart : clampedEnd;
    final actualEnd = clampedStart <= clampedEnd ? clampedEnd : clampedStart;

    final visible = <int>{};
    for (int i = actualStart; i <= actualEnd; i++) {
      visible.add(i);
    }

    final adjacent = <int>{};
    final adjacentStart = (actualStart - adjacentRadius).clamp(0, totalPageCount - 1);
    final adjacentEnd = (actualEnd + adjacentRadius).clamp(0, totalPageCount - 1);

    for (int i = adjacentStart; i <= adjacentEnd; i++) {
      if (!visible.contains(i)) {
        adjacent.add(i);
      }
    }

    final distant = <int>{};
    for (int i = 0; i < totalPageCount; i++) {
      if (!visible.contains(i) && !adjacent.contains(i)) {
        distant.add(i);
      }
    }

    return ReaderWindowResult(
      visibleIndexes: visible,
      adjacentIndexes: adjacent,
      distantIndexes: distant,
    );
  }

  /// Tính toán cửa sổ khi chỉ biết 1 trang tiêu điểm (ví dụ lúc vừa resume tới 1 trang)
  ReaderWindowResult calculateSingleFocus(int focusIndex) {
    return calculateWindow(
      visibleStartIndex: focusIndex,
      visibleEndIndex: focusIndex,
    );
  }
}

class ReaderWindowResult {
  final Set<int> visibleIndexes;
  final Set<int> adjacentIndexes;
  final Set<int> distantIndexes;

  const ReaderWindowResult({
    required this.visibleIndexes,
    required this.adjacentIndexes,
    required this.distantIndexes,
  });

  /// Có cần giữ bitmap trong bộ nhớ RAM không (thuộc Visible hoặc Adjacent)
  bool shouldRetainBitmap(int index) =>
      visibleIndexes.contains(index) || adjacentIndexes.contains(index);

  /// Có cần tải trước bitmap và signed URL không
  bool shouldPrefetch(int index) => adjacentIndexes.contains(index);

  /// Có cần giải phóng bitmap khỏi ImageCache không
  bool shouldEvict(int index) => distantIndexes.contains(index);

  @override
  String toString() =>
      'ReaderWindowResult(visible: ${visibleIndexes.length}, adjacent: ${adjacentIndexes.length}, distant: ${distantIndexes.length})';
}
