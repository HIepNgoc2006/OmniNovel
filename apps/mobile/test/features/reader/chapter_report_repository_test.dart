import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/errors/api_error.dart';
import 'package:omninovel_mobile/features/reader/models/chapter_report_models.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_report_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  setUpAll(() {
    registerFallbackValue(Options());
  });

  late MockApiClient mockApiClient;
  late ChapterReportRepository repository;

  setUp(() {
    mockApiClient = MockApiClient();
    repository = ChapterReportRepository(apiClient: mockApiClient);
  });

  group('ChapterReportRepository Tests', () {
    const chapterId = 'chapter-uuid-1';
    const versionId = 'version-uuid-1';

    test('sendReport gửi đúng payload và trả về ChapterReportResult khi thành công (201)', () async {
      const payload = ChapterReportPayload(
        chapterVersionId: versionId,
        errorType: ChapterReportErrorType.imageCorrupt,
        pageNumber: 3,
        description: 'Trang 3 bị mờ',
      );

      when(
        () => mockApiClient.post<Map<String, dynamic>>(
          ApiEndpoints.chapterReport(chapterId),
          data: any<dynamic>(named: 'data'),
        ),
      ).thenAnswer(
        (_) async => Response(
          requestOptions: RequestOptions(path: ApiEndpoints.chapterReport(chapterId)),
          statusCode: 201,
          data: {
            'success': true,
            'reportId': 'report-1234',
            'status': 'PENDING',
            'message': 'Báo cáo lỗi đã được ghi nhận.',
          },
        ),
      );

      final result = await repository.sendReport(
        chapterId: chapterId,
        payload: payload,
      );

      expect(result.success, true);
      expect(result.reportId, 'report-1234');
      expect(result.status, ChapterReportStatus.pending);

      verify(
        () => mockApiClient.post<Map<String, dynamic>>(
          ApiEndpoints.chapterReport(chapterId),
          data: {
            'chapterVersionId': versionId,
            'errorType': 'IMAGE_CORRUPT',
            'pageNumber': 3,
            'description': 'Trang 3 bị mờ',
          },
        ),
      ).called(1);
    });

    test('sendReport ném ChapterReportRateLimitException với retryAfter khi gặp 429', () async {
      const payload = ChapterReportPayload(
        chapterVersionId: versionId,
        errorType: ChapterReportErrorType.typo,
        anchorBlockId: 'block-1',
      );

      when(
        () => mockApiClient.post<Map<String, dynamic>>(
          any<String>(),
          data: any<dynamic>(named: 'data'),
        ),
      ).thenThrow(
        const ApiError(
          code: 'TOO_MANY_REQUESTS',
          message: 'Vui lòng thử lại sau.',
          statusCode: 429,
          meta: {'retryAfter': 45},
        ),
      );

      try {
        await repository.sendReport(
          chapterId: chapterId,
          payload: payload,
        );
        fail('Should throw ChapterReportRateLimitException');
      } on ChapterReportRateLimitException catch (e) {
        expect(e.retryAfter, 45);
        expect(e.message, 'Vui lòng thử lại sau.');
      }
    });

    test('sendReport ném ChapterReportDuplicateException khi gặp 409 Conflict', () async {
      const payload = ChapterReportPayload(
        chapterVersionId: versionId,
        errorType: ChapterReportErrorType.inappropriateContent,
      );

      when(
        () => mockApiClient.post<Map<String, dynamic>>(
          any<String>(),
          data: any<dynamic>(named: 'data'),
        ),
      ).thenThrow(
        const ApiError(
          code: 'CHAPTER_REPORT_DUPLICATE',
          message: 'Bạn đã gửi một báo cáo tương tự gần đây.',
          statusCode: 409,
        ),
      );

      try {
        await repository.sendReport(
          chapterId: chapterId,
          payload: payload,
        );
        fail('Should throw ChapterReportDuplicateException');
      } on ChapterReportDuplicateException catch (e) {
        expect(e.message, 'Bạn đã gửi một báo cáo tương tự gần đây.');
      }
    });
  });
}
