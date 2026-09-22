import 'dart:math' as math;
import '../models/reader_models.dart';

enum ScrollDirectionPreference {
  down,
  up,
}

/// Engine tính toán hình học chính xác cho Webtoon Reader.
/// Loại bỏ hoàn toàn ước lượng tỷ lệ cuộn (scrollFraction) sai lệch khi các trang có chiều dài khác nhau.
///
/// Các trang có chiều rộng cố định theo viewport (W), chiều cao mỗi trang H_i = W / effectiveAspectRatio_i.
/// Cung cấp mảng offset tích lũy với Binary Search O(log N) và thuật toán argmax(visibleHeight).
class WebtoonGeometryCalculator {
  final double viewportWidth;
  final List<ChapterPage> pages;

  // Mảng offset tích lũy: offsets[0] = 0, offsets[k] là vị trí bắt đầu của trang k
  // offsets[pages.length] là tổng chiều dài toàn bộ các trang (totalExtent)
  late final List<double> _cumulativeOffsets;
  late final List<double> _pageHeights;

  WebtoonGeometryCalculator({
    required this.viewportWidth,
    required this.pages,
  }) {
    _calculateOffsets();
  }

  void _calculateOffsets() {
    final n = pages.length;
    _cumulativeOffsets = List<double>.filled(n + 1, 0.0);
    _pageHeights = List<double>.filled(n, 0.0);

    double currentOffset = 0.0;
    for (int i = 0; i < n; i++) {
      _cumulativeOffsets[i] = currentOffset;
      final aspectRatio = pages[i].aspectRatio;
      final safeRatio = aspectRatio > 0 ? aspectRatio : 0.65;
      final height = viewportWidth > 0 ? viewportWidth / safeRatio : 0.0;
      _pageHeights[i] = height;
      currentOffset += height;
    }
    _cumulativeOffsets[n] = currentOffset;
  }

  /// Tổng chiều cao dự kiến của toàn bộ chương truyện
  double get totalContentHeight =>
      _cumulativeOffsets.isNotEmpty ? _cumulativeOffsets.last : 0.0;

  /// Chiều cao của trang cụ thể
  double getPageHeight(int index) {
    if (index < 0 || index >= _pageHeights.length) return 0.0;
    return _pageHeights[index];
  }

  /// Offset bắt đầu của trang cụ thể (dùng để jumpTo / animateTo khi Resume)
  double getOffsetForPage(int index) {
    if (pages.isEmpty) return 0.0;
    final clamped = index.clamp(0, pages.length - 1);
    return _cumulativeOffsets[clamped];
  }

  /// Tìm vị trí trang theo offset bằng Binary Search: O(log N)
  /// Trả về index của trang chứa điểm offset (Y_i <= offset < Y_{i+1})
  int findIndexAtOffset(double offset) {
    if (pages.isEmpty) return 0;
    if (offset <= 0) return 0;
    if (offset >= totalContentHeight) return pages.length - 1;

    int low = 0;
    int high = pages.length - 1;

    while (low <= high) {
      final mid = (low + high) >> 1;
      final start = _cumulativeOffsets[mid];
      final end = _cumulativeOffsets[mid + 1];

      if (offset >= start && offset < end) {
        return mid;
      } else if (offset < start) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return low.clamp(0, pages.length - 1);
  }

  /// Tính toán chiều cao giao diện hiển thị của trang i trong viewport [scrollOffset, scrollOffset + viewportHeight]
  double calculateVisibleHeight(
    int index,
    double scrollOffset,
    double viewportHeight,
  ) {
    if (index < 0 || index >= pages.length) return 0.0;
    final pageTop = _cumulativeOffsets[index];
    final pageBottom = _cumulativeOffsets[index + 1];
    final viewportTop = scrollOffset;
    final viewportBottom = scrollOffset + viewportHeight;

    final intersectionTop = math.max(pageTop, viewportTop);
    final intersectionBottom = math.min(pageBottom, viewportBottom);

    return math.max(0.0, intersectionBottom - intersectionTop);
  }

  /// Xác định dải trang đang hiển thị [startIndex, endIndex] trong viewport
  (int startIndex, int endIndex) findVisibleRange(
    double scrollOffset,
    double viewportHeight,
  ) {
    if (pages.isEmpty) return (0, 0);

    final clampedOffset = math.max(0.0, scrollOffset);
    final firstIndex = findIndexAtOffset(clampedOffset);
    final lastIndex = findIndexAtOffset(clampedOffset + viewportHeight);

    return (firstIndex, lastIndex);
  }

  /// Xác định trang tiêu điểm (focusedPageIndex) đang được người đọc chú ý nhiều nhất
  /// Áp dụng thuật toán argmax(visibleHeight): trang có diện tích/chiều cao giao thoa lớn nhất trong viewport.
  /// Sử dụng hướng cuộn (ScrollDirectionPreference) làm tie-breaker khi có 2 trang diện tích bằng nhau.
  int findFocusedPage(
    double scrollOffset,
    double viewportHeight, {
    ScrollDirectionPreference direction = ScrollDirectionPreference.down,
  }) {
    if (pages.isEmpty) return 0;

    final (start, end) = findVisibleRange(scrollOffset, viewportHeight);
    if (start == end) return start;

    int bestIndex = start;
    double maxVisibleHeight = -1.0;

    for (int i = start; i <= end; i++) {
      final visHeight = calculateVisibleHeight(i, scrollOffset, viewportHeight);

      if (visHeight > maxVisibleHeight) {
        maxVisibleHeight = visHeight;
        bestIndex = i;
      } else if ((visHeight - maxVisibleHeight).abs() < 1e-4) {
        // Tie-breaker: theo hướng cuộn
        if (direction == ScrollDirectionPreference.down) {
          bestIndex = i; // Ưu tiên trang phía dưới khi cuộn xuống
        }
      }
    }

    return bestIndex;
  }
}
