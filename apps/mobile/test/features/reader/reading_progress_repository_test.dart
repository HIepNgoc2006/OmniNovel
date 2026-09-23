import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient mockApiClient;
  late SharedPreferences prefs;
  late ReadingProgressRepository repository;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
    mockApiClient = MockApiClient();
    repository = ReadingProgressRepository(
      apiClient: mockApiClient,
      prefs: prefs,
    );
  });

  group('ReadingProgress Contract Parity & Repository Tests', () {
    test('ReadingProgressPayload.fromFlutterIndex maps 0-based to 1-based server index', () {
      final payload = ReadingProgressPayload.fromFlutterIndex(
        chapterId: 'ch-1',
        progressPercentage: 45.0,
        scrollPosition: 800,
        flutterPageIndex: 9, // Trang thứ 10 trong danh sách 0-indexed
        storyId: 'story-1',
        writeEpoch: 2,
      );

      expect(payload.pageIndex, 10); // 1-based cho server
      expect(payload.flutterPageIndex, 9); // internal 0-based
      expect(payload.writeEpoch, 2);
      expect(payload.toJson()['pageIndex'], 10);
      expect(payload.toJson()['writeEpoch'], 2);
    });

    test('ReadingProgressResponse parses 1-based pageIndex and provides flutterPageIndex', () {
      final json = {
        'storyId': 'story-1',
        'chapterId': 'ch-1',
        'progressPercentage': 60.0,
        'scrollPosition': 1200.0,
        'pageIndex': 15,
        'anchorBlockId': 'block-uuid',
        'textOffset': 200,
        'readChapterIds': ['ch-0', 'ch-1'],
        'writeEpoch': 3,
      };

      final response = ReadingProgressResponse.fromJson(json);

      expect(response.storyId, 'story-1');
      expect(response.pageIndex, 15);
      expect(response.flutterPageIndex, 14); // 0-based
      expect(response.anchorBlockId, 'block-uuid');
      expect(response.textOffset, 200);
      expect(response.writeEpoch, 3);
      expect(response.hasProgress, isTrue);
      expect(response.readChapterIds.length, 2);
    });

    test('saveProgress sends PUT to ApiEndpoints.readingProgress with writeEpoch', () async {
      final payload = ReadingProgressPayload.fromFlutterIndex(
        chapterId: 'ch-1',
        progressPercentage: 50.0,
        scrollPosition: 1000,
        flutterPageIndex: 2,
        storyId: 'story-1',
        writeEpoch: 5,
      );

      when(() => mockApiClient.put<Map<String, dynamic>>(
            ApiEndpoints.readingProgress,
            data: any<dynamic>(named: 'data'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.readingProgress),
          statusCode: 200,
          data: <String, dynamic>{
            'storyId': 'story-1',
            'chapterId': 'ch-1',
            'progressPercentage': 50.0,
            'scrollPosition': 1000.0,
            'pageIndex': 3,
            'textOffset': 0,
            'writeEpoch': 5,
          },
        ),
      );

      final result = await repository.saveProgress(payload);

      expect(result.pageIndex, 3);
      expect(result.flutterPageIndex, 2);
      expect(result.writeEpoch, 5);
      verify(() => mockApiClient.put<Map<String, dynamic>>(
            ApiEndpoints.readingProgress,
            data: any<dynamic>(named: 'data'),
            cancelToken: any(named: 'cancelToken'),
          )).called(1);
    });

    test('getProgress retrieves progress from ApiEndpoints.storyReadingProgress with writeEpoch', () async {
      const storyId = 'story-1';
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.storyReadingProgress(storyId)))
          .thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions:
              RequestOptions(path: ApiEndpoints.storyReadingProgress(storyId)),
          statusCode: 200,
          data: <String, dynamic>{
            'storyId': storyId,
            'chapterId': 'ch-2',
            'pageIndex': 8,
            'progressPercentage': 85.0,
            'writeEpoch': 4,
          },
        ),
      );

      final result = await repository.getProgress(storyId);

      expect(result.chapterId, 'ch-2');
      expect(result.pageIndex, 8);
      expect(result.flutterPageIndex, 7);
      expect(result.writeEpoch, 4);
      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.storyReadingProgress(storyId)))
          .called(1);
    });

    test('saveLocalCheckpoint and getLocalCheckpoint persist reading state to SharedPreferences', () async {
      const storyId = 'story-uuid-1';
      final checkpoint = LocalReadingCheckpoint(
        storyId: storyId,
        chapterId: 'ch-1',
        pageIndex: 5,
        progressPercentage: 40.0,
        scrollPosition: 600.0,
        updatedAt: DateTime.parse('2026-09-22T08:30:00Z'),
      );

      await repository.saveLocalCheckpoint(checkpoint);

      final loaded = await repository.getLocalCheckpoint(storyId);

      expect(loaded, isNotNull);
      expect(loaded?.storyId, storyId);
      expect(loaded?.chapterId, 'ch-1');
      expect(loaded?.pageIndex, 5);
      expect(loaded?.flutterPageIndex, 4);
      expect(loaded?.progressPercentage, 40.0);
      expect(loaded?.updatedAt, DateTime.parse('2026-09-22T08:30:00Z'));

      await repository.clearLocalCheckpoint(storyId);
      final afterClear = await repository.getLocalCheckpoint(storyId);
      expect(afterClear, isNull);
    });
  });
}
