import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';

void main() {
  group('Reader Models & ChapterPage Aspect Ratio Tests', () {
    test('ChapterPage calculates aspectRatio correctly when width and height are provided', () {
      final json = {
        'id': 'asset-1',
        'sortOrder': 0,
        'width': 1080,
        'height': 1920,
        'assetType': 'IMAGE_CLEAN',
        'storageKey': 'chapters/ch1/page_0.jpg',
      };

      final page = ChapterPage.fromJson(json);

      expect(page.assetId, 'asset-1');
      expect(page.sortOrder, 0);
      expect(page.width, 1080);
      expect(page.height, 1920);
      expect(page.aspectRatio, closeTo(1080 / 1920, 0.001));
    });

    test('ChapterPage fallbacks to 0.65 aspectRatio when dimensions are missing', () {
      final json = {
        'id': 'asset-2',
        'sortOrder': 1,
      };

      final page = ChapterPage.fromJson(json);

      expect(page.width, isNull);
      expect(page.height, isNull);
      expect(page.aspectRatio, 0.65);
    });

    test('ChapterDetail parses story, chapter, versions, pages and navigation', () {
      final json = {
        'story': {
          'id': 'story-1',
          'slug': 'tower-of-god',
          'title': 'Tower of God',
          'mediaFormat': 'COMIC',
          'visibility': 'PUBLIC',
        },
        'chapter': {
          'id': 'ch-1',
          'chapterNumber': '1',
          'title': 'Tầng 1: Đề Thi',
          'viewsCount': 500,
        },
        'activeVersion': {
          'id': 'ver-1',
          'versionNumber': 1,
          'versionType': 'ORIGINAL',
          'isPublished': true,
        },
        'availableVersions': [
          {'id': 'ver-1', 'versionNumber': 1, 'isPublished': true}
        ],
        'pages': [
          {'id': 'p1', 'sortOrder': 0, 'width': 800, 'height': 1200},
          {'id': 'p2', 'sortOrder': 1, 'width': 800, 'height': 1400}
        ],
        'navigation': {
          'previous': null,
          'next': {'id': 'ch-2', 'chapterNumber': '2', 'title': 'Tầng 2'}
        }
      };

      final detail = ChapterDetail.fromJson(json);

      expect(detail.story.slug, 'tower-of-god');
      expect(detail.chapter.chapterNumber, '1');
      expect(detail.activeVersion?.versionNumber, 1);
      expect(detail.pages.length, 2);
      expect(detail.navigation.previous, isNull);
      expect(detail.navigation.next?.chapterNumber, '2');
    });

    test('PresignedMediaUrlResponse parses downloadUrl and expiresInSeconds', () {
      final json = {
        'assetId': 'asset-123',
        'downloadUrl': 'https://minio.omninovel.local/media/temp-presigned-token',
        'expiresInSeconds': 3600,
      };

      final presigned = PresignedMediaUrlResponse.fromJson(json);

      expect(presigned.assetId, 'asset-123');
      expect(presigned.downloadUrl, 'https://minio.omninovel.local/media/temp-presigned-token');
      expect(presigned.expiresInSeconds, 3600);
    });
  });
}
