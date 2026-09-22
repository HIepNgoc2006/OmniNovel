import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/errors/api_error.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient mockApiClient;
  late ChapterRepository repository;

  setUp(() {
    mockApiClient = MockApiClient();
    repository = ChapterRepository(apiClient: mockApiClient);
  });

  group('ChapterRepository Tests', () {
    test('getChapterDetail returns ChapterDetail on 200', () async {
      const chapterId = 'ch-uuid-1';
      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.chapterDetails(chapterId),
            queryParameters: null,
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions:
              RequestOptions(path: ApiEndpoints.chapterDetails(chapterId)),
          statusCode: 200,
          data: <String, dynamic>{
            'story': <String, dynamic>{
              'id': 's-1',
              'slug': 'test-story',
              'title': 'Test Story',
            },
            'chapter': <String, dynamic>{
              'id': chapterId,
              'chapterNumber': '1',
            },
            'pages': <dynamic>[
              <String, dynamic>{'id': 'p-1', 'sortOrder': 0, 'width': 1080, 'height': 1920}
            ],
          },
        ),
      );

      final result = await repository.getChapterDetail(chapterId);

      expect(result.chapter.id, chapterId);
      expect(result.pages.length, 1);
      verify(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.chapterDetails(chapterId),
            queryParameters: null,
          )).called(1);
    });

    test('getChapterDetail passes versionId query parameter when provided', () async {
      const chapterId = 'ch-uuid-1';
      const versionId = 'ver-uuid-2';

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.chapterDetails(chapterId),
            queryParameters: <String, dynamic>{'versionId': versionId},
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions:
              RequestOptions(path: ApiEndpoints.chapterDetails(chapterId)),
          statusCode: 200,
          data: <String, dynamic>{
            'story': <String, dynamic>{'id': 's-1', 'slug': 'test', 'title': 'Test'},
            'chapter': <String, dynamic>{'id': chapterId, 'chapterNumber': '1'},
            'pages': <dynamic>[],
          },
        ),
      );

      await repository.getChapterDetail(chapterId, versionId: versionId);

      verify(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.chapterDetails(chapterId),
            queryParameters: <String, dynamic>{'versionId': versionId},
          )).called(1);
    });

    test('getChapterDetail rethrows ApiError properly', () async {
      const chapterId = 'ch-uuid-1';

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.chapterDetails(chapterId),
            queryParameters: null,
          )).thenThrow(
        const ApiError(
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Quá nhiều yêu cầu đọc chương, vui lòng thử lại sau ít phút.',
          statusCode: 429,
        ),
      );

      expect(
        () => repository.getChapterDetail(chapterId),
        throwsA(isA<ApiError>().having((e) => e.statusCode, 'statusCode', 429)),
      );
    });
  });
}
