import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/chapter_report_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/chapter_report_sheet.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_report_repository.dart';

class MockChapterReportRepository extends Mock implements ChapterReportRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    registerFallbackValue(
      const ChapterReportPayload(
        chapterVersionId: 'version-1',
        errorType: ChapterReportErrorType.imageCorrupt,
      ),
    );
  });

  late MockChapterReportRepository mockRepo;

  setUp(() {
    mockRepo = MockChapterReportRepository();
  });

  Widget buildTestWidget({
    required String mediaFormat,
    int? pageNumber,
    String? anchorBlockId,
  }) {
    return MaterialApp(
      home: Scaffold(
        body: ChapterReportSheet(
          chapterId: 'chap-123',
          chapterVersionId: 'ver-456',
          mediaFormat: mediaFormat,
          initialPageNumber: pageNumber,
          initialAnchorBlockId: anchorBlockId,
          repository: mockRepo,
        ),
      ),
    );
  }

  group('ChapterReportSheet Widget Tests (Gate 6 & UI)', () {
    testWidgets('Hiển thị đúng badge vị trí cho Comic (Trang 5) và gửi đúng payload khi submit', (tester) async {
      when(
        () => mockRepo.sendReport(
          chapterId: any(named: 'chapterId'),
          payload: any(named: 'payload'),
        ),
      ).thenAnswer(
        (_) async => const ChapterReportResult(
          success: true,
          reportId: 'rep-1',
          status: ChapterReportStatus.pending,
          message: 'Báo cáo thành công',
        ),
      );

      await tester.pumpWidget(buildTestWidget(mediaFormat: 'COMIC', pageNumber: 5));
      await tester.pumpAndSettle();

      expect(find.text('Báo lỗi chương truyện'), findsOneWidget);
      expect(find.text('Trang 5'), findsOneWidget);

      // Nhập mô tả
      await tester.enterText(find.byType(TextField), 'Trang 5 bị lệch màu');
      await tester.pumpAndSettle();

      // Nhấn gửi
      await tester.tap(find.text('Gửi báo cáo'));
      await tester.pump();

      verify(
        () => mockRepo.sendReport(
          chapterId: 'chap-123',
          payload: any(
            named: 'payload',
            that: isA<ChapterReportPayload>()
                .having((p) => p.chapterVersionId, 'versionId', 'ver-456')
                .having((p) => p.pageNumber, 'pageNumber', 5)
                .having((p) => p.anchorBlockId, 'anchorBlockId', isNull)
                .having((p) => p.description, 'description', 'Trang 5 bị lệch màu'),
          ),
        ),
      ).called(1);
    });

    testWidgets('Hiển thị đúng badge vị trí cho Novel (Đoạn: p-42)', (tester) async {
      await tester.pumpWidget(buildTestWidget(mediaFormat: 'NOVEL', anchorBlockId: 'p-42'));
      await tester.pumpAndSettle();

      expect(find.text('Đoạn: p-42'), findsOneWidget);
    });

    testWidgets('Toggle "Báo lỗi cho toàn bộ chương truyện" xóa location context thành null', (tester) async {
      when(
        () => mockRepo.sendReport(
          chapterId: any(named: 'chapterId'),
          payload: any(named: 'payload'),
        ),
      ).thenAnswer(
        (_) async => const ChapterReportResult(
          success: true,
          reportId: 'rep-2',
          status: ChapterReportStatus.pending,
          message: 'Báo cáo thành công',
        ),
      );

      await tester.pumpWidget(buildTestWidget(mediaFormat: 'COMIC', pageNumber: 8));
      await tester.pumpAndSettle();

      expect(find.text('Trang 8'), findsOneWidget);

      // Bật checkbox toàn bộ chương
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();

      expect(find.text('Toàn bộ chương'), findsOneWidget);

      // Gửi báo cáo
      await tester.tap(find.text('Gửi báo cáo'));
      await tester.pump();

      verify(
        () => mockRepo.sendReport(
          chapterId: 'chap-123',
          payload: any(
            named: 'payload',
            that: isA<ChapterReportPayload>()
                .having((p) => p.pageNumber, 'pageNumber', isNull)
                .having((p) => p.anchorBlockId, 'anchorBlockId', isNull),
          ),
        ),
      ).called(1);
    });

    testWidgets('Khi gặp Rate Limit 429 -> Hiển thị countdown timer và vô hiệu hóa nút submit', (tester) async {
      when(
        () => mockRepo.sendReport(
          chapterId: any(named: 'chapterId'),
          payload: any(named: 'payload'),
        ),
      ).thenThrow(
        const ChapterReportRateLimitException(
          retryAfter: 30,
          message: 'Gửi quá nhanh',
        ),
      );

      await tester.pumpWidget(buildTestWidget(mediaFormat: 'COMIC', pageNumber: 1));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Gửi báo cáo'));
      await tester.pumpAndSettle();

      expect(find.text('Vui lòng chờ 30s'), findsOneWidget);

      // Nút bị vô hiệu hóa
      final filledButton = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(filledButton.onPressed, isNull);
    });

    testWidgets('Khi gặp Duplicate 409 -> Hiển thị thông báo duplicate', (tester) async {
      when(
        () => mockRepo.sendReport(
          chapterId: any(named: 'chapterId'),
          payload: any(named: 'payload'),
        ),
      ).thenThrow(
        const ChapterReportDuplicateException(
          message: 'Báo cáo tương tự đang chờ xử lý.',
        ),
      );

      await tester.pumpWidget(buildTestWidget(mediaFormat: 'COMIC', pageNumber: 1));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Gửi báo cáo'));
      await tester.pumpAndSettle();

      expect(find.text('Báo cáo tương tự đang chờ xử lý.'), findsOneWidget);
    });
  });
}
