import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_window_policy.dart';

void main() {
  group('ReaderWindowPolicy Pure Dart 3-Zone Memory Window Tests', () {
    test('N=0: Empty pages returns empty sets', () {
      const policy = ReaderWindowPolicy(totalPageCount: 0);
      final result = policy.calculateWindow(visibleStartIndex: 0, visibleEndIndex: 0);

      expect(result.visibleIndexes, isEmpty);
      expect(result.adjacentIndexes, isEmpty);
      expect(result.distantIndexes, isEmpty);
    });

    test('N=1: Single page chapter', () {
      const policy = ReaderWindowPolicy(totalPageCount: 1);
      final result = policy.calculateWindow(visibleStartIndex: 0, visibleEndIndex: 0);

      expect(result.visibleIndexes, {0});
      expect(result.adjacentIndexes, isEmpty);
      expect(result.distantIndexes, isEmpty);
      expect(result.shouldRetainBitmap(0), isTrue);
      expect(result.shouldEvict(0), isFalse);
    });

    test('First page focus with radius=2: [0] visible, [1, 2] adjacent, rest distant', () {
      const policy = ReaderWindowPolicy(totalPageCount: 10, adjacentRadius: 2);
      final result = policy.calculateSingleFocus(0);

      expect(result.visibleIndexes, {0});
      expect(result.adjacentIndexes, {1, 2});
      expect(result.distantIndexes, {3, 4, 5, 6, 7, 8, 9});

      expect(result.shouldRetainBitmap(0), isTrue);
      expect(result.shouldRetainBitmap(1), isTrue);
      expect(result.shouldRetainBitmap(2), isTrue);
      expect(result.shouldRetainBitmap(3), isFalse);
      expect(result.shouldEvict(3), isTrue);
    });

    test('Middle page focus (page 5): [5] visible, [3, 4, 6, 7] adjacent, [0..2, 8..9] distant', () {
      const policy = ReaderWindowPolicy(totalPageCount: 10, adjacentRadius: 2);
      final result = policy.calculateSingleFocus(5);

      expect(result.visibleIndexes, {5});
      expect(result.adjacentIndexes, {3, 4, 6, 7});
      expect(result.distantIndexes, {0, 1, 2, 8, 9});

      expect(result.shouldRetainBitmap(5), isTrue);
      expect(result.shouldPrefetch(4), isTrue);
      expect(result.shouldPrefetch(6), isTrue);
      expect(result.shouldEvict(1), isTrue);
      expect(result.shouldEvict(9), isTrue);
    });

    test('Last page focus: [9] visible, [7, 8] adjacent, [0..6] distant', () {
      const policy = ReaderWindowPolicy(totalPageCount: 10, adjacentRadius: 2);
      final result = policy.calculateSingleFocus(9);

      expect(result.visibleIndexes, {9});
      expect(result.adjacentIndexes, {7, 8});
      expect(result.distantIndexes, {0, 1, 2, 3, 4, 5, 6});
    });

    test('Two visible pages: [3, 4] visible, [1, 2, 5, 6] adjacent, rest distant', () {
      const policy = ReaderWindowPolicy(totalPageCount: 20, adjacentRadius: 2);
      final result = policy.calculateWindow(visibleStartIndex: 3, visibleEndIndex: 4);

      expect(result.visibleIndexes, {3, 4});
      expect(result.adjacentIndexes, {1, 2, 5, 6});
      expect(result.distantIndexes.length, 14); // 20 - 2 - 4 = 14
      expect(result.distantIndexes.contains(0), isTrue);
      expect(result.distantIndexes.contains(7), isTrue);
    });

    test('Stress Test: 100 pages chapter memory boundary bounds', () {
      const total = 100;
      const policy = ReaderWindowPolicy(totalPageCount: total, adjacentRadius: 2);

      // Đọc trang 50
      final result = policy.calculateSingleFocus(50);

      expect(result.visibleIndexes, {50});
      expect(result.adjacentIndexes, {48, 49, 51, 52});
      expect(result.distantIndexes.length, 95);

      // Tổng số index phải bằng chính xác 100 trang, không trùng lặp
      final union = {
        ...result.visibleIndexes,
        ...result.adjacentIndexes,
        ...result.distantIndexes,
      };
      expect(union.length, total);
    });

    test('Stress Test: 200 pages chapter memory boundary bounds', () {
      const total = 200;
      const policy = ReaderWindowPolicy(totalPageCount: total, adjacentRadius: 3);

      final result = policy.calculateWindow(visibleStartIndex: 120, visibleEndIndex: 122);

      expect(result.visibleIndexes, {120, 121, 122});
      expect(result.adjacentIndexes, {117, 118, 119, 123, 124, 125});
      expect(result.distantIndexes.length, 200 - 3 - 6);

      final union = {
        ...result.visibleIndexes,
        ...result.adjacentIndexes,
        ...result.distantIndexes,
      };
      expect(union.length, total);
    });
  });
}
