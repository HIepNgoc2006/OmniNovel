import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart';

void main() {
  group('Story Models Serialization & Contract Tests', () {
    test('Genre.fromJson should parse correctly', () {
      final json = {
        'id': 'genre-uuid-1',
        'name': 'Hành Động',
        'slug': 'action',
      };
      final genre = Genre.fromJson(json);

      expect(genre.id, 'genre-uuid-1');
      expect(genre.name, 'Hành Động');
      expect(genre.slug, 'action');
      expect(genre.toJson(), json);
    });

    test('ChapterItemSummary.fromJson should handle missing fields gracefully', () {
      final json = {
        'id': 'chapter-1',
        'chapterNumber': 12,
        'viewsCount': 250,
      };
      final chapter = ChapterItemSummary.fromJson(json);

      expect(chapter.id, 'chapter-1');
      expect(chapter.chapterNumber, '12');
      expect(chapter.title, isNull);
      expect(chapter.viewsCount, 250);
      expect(chapter.createdAt, isNull);
    });

    test('StoryDetail.fromJson and defaultChapters helper', () {
      final json = {
        'id': 'story-uuid-1',
        'slug': 'solo-leveling',
        'title': 'Tôi Thăng Cấp Một Mình',
        'mediaFormat': 'COMIC',
        'status': 'COMPLETED',
        'viewsCount': 1000000,
        'genres': [
          {'id': 'g1', 'name': 'Fantasy', 'slug': 'fantasy'}
        ],
        'editions': [
          {
            'id': 'ed-1',
            'editionName': 'Bản Dịch Chính Thức',
            'isDefault': true,
            'chapters': [
              {'id': 'ch-1', 'chapterNumber': '1', 'title': 'Khởi đầu'},
              {'id': 'ch-2', 'chapterNumber': '2', 'title': 'Hầm ngục kép'}
            ]
          }
        ]
      };

      final story = StoryDetail.fromJson(json);

      expect(story.id, 'story-uuid-1');
      expect(story.slug, 'solo-leveling');
      expect(story.genres.length, 1);
      expect(story.genres.first.name, 'Fantasy');
      expect(story.editions.length, 1);
      expect(story.defaultChapters.length, 2);
      expect(story.defaultChapters.first.title, 'Khởi đầu');
    });

    test('FeaturedStoriesResponse should parse hotStories and banners', () {
      final json = {
        'hotStories': [
          {
            'id': 'story-1',
            'slug': 'story-1',
            'title': 'Truyện Hot 1',
            'mediaFormat': 'COMIC',
          }
        ],
        'banners': [
          {
            'id': 'story-1',
            'slug': 'story-1',
            'title': 'Truyện Hot 1',
            'mediaFormat': 'COMIC',
          }
        ]
      };

      final featured = FeaturedStoriesResponse.fromJson(json);

      expect(featured.hotStories.length, 1);
      expect(featured.banners.length, 1);
      expect(featured.hotStories.first.title, 'Truyện Hot 1');
    });
  });
}
