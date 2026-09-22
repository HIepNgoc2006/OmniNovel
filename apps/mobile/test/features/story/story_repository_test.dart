import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/errors/api_error.dart';
import 'package:omninovel_mobile/features/story/repositories/story_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient mockApiClient;
  late StoryRepository repository;

  setUp(() {
    mockApiClient = MockApiClient();
    repository = StoryRepository(apiClient: mockApiClient);
  });

  group('StoryRepository Tests', () {
    test('getFeaturedStories should return FeaturedStoriesResponse on 200', () async {
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.storiesFeatured)).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.storiesFeatured),
          statusCode: 200,
          data: <String, dynamic>{
            'hotStories': <dynamic>[
              <String, dynamic>{
                'id': 'story-1',
                'slug': 'solo-leveling',
                'title': 'Solo Leveling',
                'mediaFormat': 'COMIC',
              }
            ],
            'banners': <dynamic>[]
          },
        ),
      );

      final result = await repository.getFeaturedStories();

      expect(result.hotStories.length, 1);
      expect(result.hotStories.first.slug, 'solo-leveling');
      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.storiesFeatured)).called(1);
    });

    test('getStoryBySlug should return StoryDetail on 200', () async {
      const slug = 'solo-leveling';
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.storyBySlug(slug))).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.storyBySlug(slug)),
          statusCode: 200,
          data: <String, dynamic>{
            'id': 'story-uuid-1',
            'slug': slug,
            'title': 'Solo Leveling',
            'mediaFormat': 'COMIC',
            'editions': <dynamic>[
              <String, dynamic>{
                'id': 'ed-1',
                'editionName': 'Official',
                'isDefault': true,
                'chapters': <dynamic>[
                  <String, dynamic>{'id': 'ch-1', 'chapterNumber': '1', 'title': 'Chương 1'}
                ]
              }
            ]
          },
        ),
      );

      final result = await repository.getStoryBySlug(slug);

      expect(result.slug, slug);
      expect(result.defaultChapters.length, 1);
      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.storyBySlug(slug))).called(1);
    });

    test('getStoryBySlug should rethrow ApiError on error', () async {
      const slug = 'non-existing';
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.storyBySlug(slug))).thenThrow(
        const ApiError(
          code: 'NOT_FOUND',
          message: 'Không tìm thấy bộ truyện',
          statusCode: 404,
        ),
      );

      expect(
        () => repository.getStoryBySlug(slug),
        throwsA(isA<ApiError>().having((e) => e.statusCode, 'statusCode', 404)),
      );
    });
  });
}
