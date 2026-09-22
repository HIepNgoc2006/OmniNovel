import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/errors/api_error.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient mockApiClient;
  late MediaRepository repository;

  setUp(() {
    mockApiClient = MockApiClient();
    repository = MediaRepository(apiClient: mockApiClient);
  });

  group('MediaRepository Presigned URL & Anti-Leech Cache Tests', () {
    const assetId = 'asset-uuid-1';
    const downloadUrl = 'https://minio.omninovel.local/media/signed-token-123';

    test('getMediaDownloadUrl fetches from API and caches url', () async {
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.mediaUrl(assetId))).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.mediaUrl(assetId)),
          statusCode: 200,
          data: <String, dynamic>{
            'assetId': assetId,
            'downloadUrl': downloadUrl,
            'expiresInSeconds': 3600,
          },
        ),
      );

      // Lần 1: Gọi API
      final url1 = await repository.getMediaDownloadUrl(assetId);
      expect(url1, downloadUrl);

      // Lần 2: Trả từ cache, không gọi API nữa (chống spam 60req/phút)
      final url2 = await repository.getMediaDownloadUrl(assetId);
      expect(url2, downloadUrl);

      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.mediaUrl(assetId))).called(1);
    });

    test('getMediaDownloadUrl with forceRefresh bypasses cache', () async {
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.mediaUrl(assetId))).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.mediaUrl(assetId)),
          statusCode: 200,
          data: <String, dynamic>{
            'assetId': assetId,
            'downloadUrl': downloadUrl,
            'expiresInSeconds': 3600,
          },
        ),
      );

      await repository.getMediaDownloadUrl(assetId);
      await repository.getMediaDownloadUrl(assetId, forceRefresh: true);

      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.mediaUrl(assetId))).called(2);
    });

    test('invalidate clears specific asset cache', () async {
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.mediaUrl(assetId))).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.mediaUrl(assetId)),
          statusCode: 200,
          data: <String, dynamic>{
            'assetId': assetId,
            'downloadUrl': downloadUrl,
            'expiresInSeconds': 3600,
          },
        ),
      );

      await repository.getMediaDownloadUrl(assetId);
      repository.invalidate(assetId);
      await repository.getMediaDownloadUrl(assetId);

      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.mediaUrl(assetId))).called(2);
    });

    test('getMediaDownloadUrl throws ApiError when backend returns 403 Forbidden', () async {
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.mediaUrl(assetId))).thenThrow(
        const ApiError(
          code: 'FORBIDDEN',
          message: 'Không có quyền truy cập tài nguyên ảnh này.',
          statusCode: 403,
        ),
      );

      expect(
        () => repository.getMediaDownloadUrl(assetId),
        throwsA(isA<ApiError>().having((e) => e.statusCode, 'statusCode', 403)),
      );
    });
  });
}
