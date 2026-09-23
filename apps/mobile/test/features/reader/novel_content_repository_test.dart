import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/novel_content_repository.dart';

class MockMediaRepository extends Mock implements MediaRepository {}

void main() {
  late MockMediaRepository mockMediaRepo;
  late Dio assetDio;
  late NovelContentRepository novelRepo;
  late List<RequestOptions> capturedRequests;

  setUp(() {
    mockMediaRepo = MockMediaRepository();
    capturedRequests = [];

    assetDio = Dio();
    assetDio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          capturedRequests.add(options);
          if (options.path.contains('expired')) {
            return handler.reject(
              DioException(
                requestOptions: options,
                response: Response(
                  requestOptions: options,
                  statusCode: 403,
                  statusMessage: 'Forbidden',
                ),
                type: DioExceptionType.badResponse,
              ),
            );
          }
          return handler.resolve(
            Response(
              requestOptions: options,
              data: '<p data-anchor-block-id="blk_0001_p">Hello Novel</p>',
              statusCode: 200,
            ),
          );
        },
      ),
    );

    novelRepo = NovelContentRepository(
      mediaRepository: mockMediaRepo,
      assetDio: assetDio,
    );
  });

  test('Security Invariant: Tải presigned URL tuyệt đối KHÔNG chứa header Authorization', () async {
    const assetId = 'asset-123';
    const presignedUrl = 'https://minio.omninovel.test/novels/chapter1.html?signature=abc';

    when(() => mockMediaRepo.getMediaDownloadUrl(assetId))
        .thenAnswer((_) async => presignedUrl);

    final html = await novelRepo.loadNovelHtml(assetId);

    expect(html, contains('Hello Novel'));
    expect(capturedRequests.length, 1);
    final req = capturedRequests.first;
    expect(req.uri.toString(), presignedUrl);

    // SECURITY CHECK: Invariant không được gửi Authorization token sang storage URL
    expect(req.headers.containsKey('Authorization'), isFalse);
    expect(req.headers['Authorization'], isNull);
  });

  test('One-shot 403 recovery: Tự động invalidate và fetch lại URL mới khi gặp 403 Forbidden', () async {
    const assetId = 'asset-456';
    const expiredUrl = 'https://minio.omninovel.test/novels/expired.html';
    const freshUrl = 'https://minio.omninovel.test/novels/fresh.html';

    when(() => mockMediaRepo.getMediaDownloadUrl(assetId))
        .thenAnswer((_) async => expiredUrl);
    when(() => mockMediaRepo.invalidate(assetId)).thenReturn(null);
    when(() => mockMediaRepo.getMediaDownloadUrl(assetId, forceRefresh: true))
        .thenAnswer((_) async => freshUrl);

    final html = await novelRepo.loadNovelHtml(assetId);

    expect(html, contains('Hello Novel'));
    expect(capturedRequests.length, 2);
    expect(capturedRequests[0].uri.toString(), expiredUrl);
    expect(capturedRequests[1].uri.toString(), freshUrl);

    verify(() => mockMediaRepo.invalidate(assetId)).called(1);
    verify(() => mockMediaRepo.getMediaDownloadUrl(assetId, forceRefresh: true)).called(1);
  });

  test('In-memory Cache: Không gọi lại MediaRepository khi assetId đã được cache', () async {
    const assetId = 'asset-789';
    const presignedUrl = 'https://minio.omninovel.test/novels/cached.html';

    when(() => mockMediaRepo.getMediaDownloadUrl(assetId))
        .thenAnswer((_) async => presignedUrl);

    final html1 = await novelRepo.loadNovelHtml(assetId);
    final html2 = await novelRepo.loadNovelHtml(assetId);

    expect(html1, html2);
    expect(capturedRequests.length, 1);
    verify(() => mockMediaRepo.getMediaDownloadUrl(assetId)).called(1);
  });
}
