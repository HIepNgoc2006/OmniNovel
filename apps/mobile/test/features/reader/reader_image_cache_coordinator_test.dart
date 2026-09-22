import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_image_cache_coordinator.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';

class MockMediaRepository extends Mock implements MediaRepository {}
class MockBuildContext extends Mock implements BuildContext {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockMediaRepository mockMediaRepo;
  late ReaderImageCacheCoordinator coordinator;

  setUp(() {
    mockMediaRepo = MockMediaRepository();
    coordinator = ReaderImageCacheCoordinator(
      mediaRepository: mockMediaRepo,
      imageBudgetBytes: 50 * 1024 * 1024, // 50MB budget for testing
    );
  });

  tearDown(() {
    coordinator.dispose();
  });

  const testPage1 = ChapterPage(
    assetId: 'asset-1',
    sortOrder: 1,
    width: 1080,
    height: 1920,
  );

  const testPage2 = ChapterPage(
    assetId: 'asset-2',
    sortOrder: 2,
    width: 1080,
    height: 4000, // Webtoon rất dài
  );

  group('ReaderImageCacheCoordinator Tests', () {
    test('getImageProvider bọc ResizeImage khi có targetWidth', () {
      final provider = coordinator.getImageProvider(
        'asset-1',
        'https://minio.example.com/asset-1.jpg?token=abc',
        targetWidth: 1080,
        page: testPage1,
      );

      expect(provider, isA<ResizeImage>());
      final resize = provider as ResizeImage;
      expect(resize.width, 1080);
      expect(resize.allowUpscaling, false);
    });

    test('tái sử dụng ImageProvider nếu url và targetWidth không đổi', () {
      final provider1 = coordinator.getImageProvider(
        'asset-1',
        'https://minio.example.com/asset-1.jpg?token=abc',
        targetWidth: 1080,
        page: testPage1,
      );

      final provider2 = coordinator.getImageProvider(
        'asset-1',
        'https://minio.example.com/asset-1.jpg?token=abc',
        targetWidth: 1080,
        page: testPage1,
      );

      expect(identical(provider1, provider2), isTrue);
    });

    test('xoay vòng Signed URL: tự động evict và tạo provider mới khi URL thay đổi', () {
      final providerOld = coordinator.getImageProvider(
        'asset-1',
        'https://minio.example.com/asset-1.jpg?token=OLD',
        targetWidth: 1080,
        page: testPage1,
      );

      final providerNew = coordinator.getImageProvider(
        'asset-1',
        'https://minio.example.com/asset-1.jpg?token=NEW',
        targetWidth: 1080,
        page: testPage1,
      );

      expect(identical(providerOld, providerNew), isFalse);
    });

    test('refreshPageUrl gọi invalidate và lấy signed URL mới với forceRefresh = true', () async {
      when(() => mockMediaRepo.invalidate('asset-1')).thenReturn(null);
      when(() => mockMediaRepo.getMediaDownloadUrl('asset-1', forceRefresh: true))
          .thenAnswer((_) async => 'https://minio.example.com/asset-1.jpg?token=REFRESHED');

      final url = await coordinator.refreshPageUrl(testPage1);

      expect(url, 'https://minio.example.com/asset-1.jpg?token=REFRESHED');
      verify(() => mockMediaRepo.invalidate('asset-1')).called(1);
      verify(() => mockMediaRepo.getMediaDownloadUrl('asset-1', forceRefresh: true)).called(1);
    });

    test('estimateDecodedBytes tính toán chính xác RGBA 4 bytes/pixel', () {
      // testPage1: width 1080, height 1920 -> ratio = 1080/1920 = 0.5625
      // targetWidth = 1080 -> decoded height = 1080 / 0.5625 = 1920
      // bytes = 1080 * 1920 * 4 = 8,294,400 bytes (~7.9MB)
      final bytes1 = ReaderImageCacheCoordinator.estimateDecodedBytes(testPage1, 1080);
      expect(bytes1, 8294400);

      // testPage2: width 1080, height 4000 -> ratio = 1080/4000 = 0.27
      // targetWidth = 1080 -> decoded height = 4000
      // bytes = 1080 * 4000 * 4 = 17,280,000 bytes (~16.48MB)
      final bytes2 = ReaderImageCacheCoordinator.estimateDecodedBytes(testPage2, 1080);
      expect(bytes2, 17280000);
    });

    test('evictDistantBitmaps giải phóng provider của các trang xa khỏi memory map', () {
      coordinator.getImageProvider(
        'asset-1',
        'https://minio.example.com/asset-1.jpg',
        targetWidth: 1080,
        page: testPage1,
      );
      coordinator.getImageProvider(
        'asset-2',
        'https://minio.example.com/asset-2.jpg',
        targetWidth: 1080,
        page: testPage2,
      );

      expect(coordinator.currentDecodedBytes, greaterThan(0));

      coordinator.evictDistantBitmaps(
        pages: [testPage1, testPage2],
        distantIndexes: {0}, // Evict testPage1
      );

      // Sau khi evict testPage1, chỉ còn testPage2
      expect(coordinator.currentDecodedBytes, 17280000);
    });
  });
}
