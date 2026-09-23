import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart';

void main() {
  group('Story Models Serialization & Contract Tests', () {
    test('parseIntLike handles int, num, string bigint, and invalid fallback', () {
      expect(parseIntLike(42), 42);
      expect(parseIntLike(42.8), 42);
      expect(parseIntLike('1000000'), 1000000);
      expect(parseIntLike('0'), 0);
      expect(parseIntLike(null), 0);
      expect(parseIntLike('not_a_number'), 0);
      expect(parseIntLike(<dynamic>[]), 0);
    });

    test('Genre.fromJson should parse correctly with int id', () {
      final json = {
        'id': 1,
        'name': 'Hành Động',
        'slug': 'action',
      };
      final genre = Genre.fromJson(json);

      expect(genre.id, 1);
      expect(genre.name, 'Hành Động');
      expect(genre.slug, 'action');
      expect(genre.toJson(), json);
    });

    test('Genre.fromJson should parse string id to int safely via parseIntLike', () {
      final json = {
        'id': '99',
        'name': 'Phiêu Lưu',
        'slug': 'adventure',
      };
      final genre = Genre.fromJson(json);

      expect(genre.id, 99);
      expect(genre.name, 'Phiêu Lưu');
    });

    test('ChapterItemSummary.fromJson handles volumeId and string viewsCount bigint', () {
      final json = {
        'id': 'chapter-1',
        'volumeId': 'vol-1',
        'chapterNumber': 12,
        'viewsCount': '250000',
      };
      final chapter = ChapterItemSummary.fromJson(json);

      expect(chapter.id, 'chapter-1');
      expect(chapter.volumeId, 'vol-1');
      expect(chapter.chapterNumber, '12');
      expect(chapter.title, isNull);
      expect(chapter.viewsCount, 250000);
      expect(chapter.createdAt, isNull);
    });

    test('VolumeSummary.fromJson and StoryEdition.volumes parsing', () {
      final jsonEdition = {
        'id': 'ed-1',
        'editionName': 'Bản In',
        'isDefault': true,
        'volumes': [
          {
            'id': 'vol-1',
            'volumeNumber': 1,
            'title': 'Tập 1: Khởi Nguyên',
            'coverUrl': 'https://example.com/vol1.jpg',
          }
        ],
        'chapters': [
          {
            'id': 'ch-1',
            'volumeId': 'vol-1',
            'chapterNumber': '1',
            'title': 'Chương 1',
          }
        ]
      };

      final edition = StoryEdition.fromJson(jsonEdition);
      expect(edition.volumes.length, 1);
      expect(edition.volumes.first.volumeNumber, 1);
      expect(edition.volumes.first.title, 'Tập 1: Khởi Nguyên');
      expect(edition.chapters.length, 1);
      expect(edition.chapters.first.volumeId, 'vol-1');
    });

    test('StoryDetail.fromJson and defaultChapters / defaultVolumes helper', () {
      final json = {
        'id': 'story-uuid-1',
        'slug': 'solo-leveling',
        'title': 'Tôi Thăng Cấp Một Mình',
        'mediaFormat': 'COMIC',
        'publicationFormat': 'MANHWA',
        'status': 'COMPLETED',
        'viewsCount': '1000000',
        'followersCount': '5000',
        'genres': [
          {'id': 1, 'name': 'Fantasy', 'slug': 'fantasy'}
        ],
        'editions': [
          {
            'id': 'ed-1',
            'editionName': 'Bản Dịch Chính Thức',
            'isDefault': true,
            'volumes': [
              {
                'id': 'vol-1',
                'volumeNumber': 1,
                'title': 'Hầm Ngục Kép',
              }
            ],
            'chapters': [
              {'id': 'ch-1', 'volumeId': 'vol-1', 'chapterNumber': '1', 'title': 'Khởi đầu'},
              {'id': 'ch-2', 'volumeId': 'vol-1', 'chapterNumber': '2', 'title': 'Hầm ngục kép'}
            ]
          }
        ]
      };

      final story = StoryDetail.fromJson(json);

      expect(story.id, 'story-uuid-1');
      expect(story.slug, 'solo-leveling');
      expect(story.publicationFormat, 'MANHWA');
      expect(story.viewsCount, 1000000);
      expect(story.followersCount, 5000);
      expect(story.genres.length, 1);
      expect(story.genres.first.id, 1);
      expect(story.genres.first.name, 'Fantasy');
      expect(story.editions.length, 1);
      expect(story.defaultVolumes.length, 1);
      expect(story.defaultChapters.length, 2);
      expect(story.defaultChapters.first.title, 'Khởi đầu');
    });

    test('StoryRankingsResponse should parse topComics and topNovels', () {
      final json = {
        'topComics': [
          {'id': 's1', 'slug': 's1', 'title': 'Comic Top', 'viewsCount': '500'}
        ],
        'topNovels': [
          {'id': 's2', 'slug': 's2', 'title': 'Novel Top', 'viewsCount': '300'}
        ],
      };

      final rankings = StoryRankingsResponse.fromJson(json);
      expect(rankings.topComics.length, 1);
      expect(rankings.topNovels.length, 1);
      expect(rankings.topComics.first.title, 'Comic Top');
      expect(rankings.topNovels.first.title, 'Novel Top');
    });

    test('PaginationMeta and PaginatedStoriesResponse parse correctly', () {
      final json = {
        'data': [
          {'id': 's1', 'slug': 's1', 'title': 'Truyện 1'}
        ],
        'pagination': {
          'page': '1',
          'limit': '20',
          'total': '45',
          'totalPages': '3',
        }
      };

      final res = PaginatedStoriesResponse.fromJson(json);
      expect(res.data.length, 1);
      expect(res.pagination.page, 1);
      expect(res.pagination.total, 45);
      expect(res.pagination.totalPages, 3);
      expect(res.pagination.hasNextPage, isTrue);
    });

    test('FindStoriesParams.toQueryParams formats query strings properly', () {
      const params = FindStoriesParams(
        page: 2,
        limit: 15,
        format: 'COMIC',
        genre: 'action',
        status: 'ONGOING',
        search: 'hunter',
        sort: 'VIEWS',
      );

      final map = params.toQueryParams();
      expect(map['page'], '2');
      expect(map['limit'], '15');
      expect(map['format'], 'COMIC');
      expect(map['genre'], 'action');
      expect(map['status'], 'ONGOING');
      expect(map['search'], 'hunter');
      expect(map['sort'], 'VIEWS');
    });
  });
}
