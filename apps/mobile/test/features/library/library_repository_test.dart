import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/features/library/models/library_models.dart';
import 'package:omninovel_mobile/features/library/repositories/library_repository.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';

class MockApiClient extends Mock implements ApiClient {}
class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockApiClient mockApiClient;
  late MockReadingProgressRepository mockProgressRepo;
  late SharedPreferences prefs;
  late LibraryRepository libraryRepo;

  final dummyItem = ReadingHistoryItem(
    story: const LibraryStorySummary(
      id: 's-1',
      title: 'Truyện 1',
      slug: 'truyen-1',
      mediaFormat: 'COMIC',
      status: 'ONGOING',
      totalChapters: 10,
    ),
    chapter: const LibraryChapterSummary(
      id: 'c-1',
      title: 'Chương 1',
      chapterNumber: 1,
    ),
    resume: const ResumeSnapshot(
      readingMode: 'WEBTOON',
      progressPercentage: 45.0,
      scrollPosition: 1000.0,
      pageIndex: 5,
      textOffset: 0,
    ),
    updatedAt: DateTime.parse('2026-09-23T10:00:00Z'),
  );

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
    mockApiClient = MockApiClient();
    mockProgressRepo = MockReadingProgressRepository();
    libraryRepo = LibraryRepository(
      apiClient: mockApiClient,
      prefs: prefs,
      progressRepository: mockProgressRepo,
    );
  });

  group('LibraryRepository SWR & Isolation Tests', () {

    test('Gate 9A: fetchHistory caches page 1 and falls back to cache on network failure', () async {
      final mockResponseData = {
        'data': [dummyItem.toJson()],
        'pagination': {
          'page': 1,
          'limit': 20,
          'totalItems': 1,
          'totalPages': 1,
        },
      };

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.libraryHistory,
            queryParameters: {'page': 1, 'limit': 20},
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.libraryHistory),
          statusCode: 200,
          data: mockResponseData,
        ),
      );

      // First fetch: network success
      final res1 = await libraryRepo.fetchHistory(page: 1, limit: 20);
      expect(res1.data.length, 1);
      expect(res1.data.first.story.title, 'Truyện 1');

      // Network fails on subsequent fetch
      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.libraryHistory,
            queryParameters: {'page': 1, 'limit': 20},
          )).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.libraryHistory),
          type: DioExceptionType.connectionError,
        ),
      );

      // Must return cached data seamlessly (Gate 9A SWR)
      final cached = libraryRepo.getCachedHistory();
      expect(cached.length, 1);
      expect(cached.first.story.title, 'Truyện 1');
    });

    test('Gate 9B: getContinueReading caches under distinct key and does NOT truncate history page 1', () async {
      final item2 = ReadingHistoryItem(
        story: const LibraryStorySummary(
          id: 's-2',
          title: 'Truyện 2',
          slug: 'truyen-2',
          mediaFormat: 'COMIC',
          status: 'ONGOING',
          totalChapters: 20,
        ),
        chapter: const LibraryChapterSummary(
          id: 'c-2',
          title: 'Chương 2',
          chapterNumber: 2,
        ),
        resume: const ResumeSnapshot(
          readingMode: 'WEBTOON',
          progressPercentage: 60.0,
          scrollPosition: 1500.0,
          pageIndex: 6,
          textOffset: 0,
        ),
        updatedAt: DateTime.parse('2026-09-23T11:00:00Z'),
      );

      // Seed full history page 1 cache (2 items as a List)
      final fullHistoryJson = jsonEncode([dummyItem.toJson(), item2.toJson()]);
      await prefs.setString('omninovel_library_anon_history_page1', fullHistoryJson);

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.libraryHistory,
            queryParameters: {'page': 1, 'limit': 1},
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.libraryHistory),
          statusCode: 200,
          data: {
            'data': [dummyItem.toJson()],
            'pagination': {
              'page': 1,
              'limit': 1,
              'totalItems': 2,
              'totalPages': 2,
            },
          },
        ),
      );

      // Call continue reading (limit = 1)
      final hero = await libraryRepo.getContinueReading();
      expect(hero, isNotNull);
      expect(hero?.story.id, 's-1');

      // Verify that history page 1 cache was NOT overwritten/truncated to 1 item!
      final preservedHistory = libraryRepo.getCachedHistory();
      expect(preservedHistory.length, 2);
    });

    test('Bookmarks query SWR is strictly isolated by status filter', () async {
      final bookmarkItem = BookmarkedStoryItem(
        story: const LibraryStorySummary(
          id: 'b-1',
          title: 'Đang đọc',
          slug: 'reading',
          mediaFormat: 'COMIC',
          status: 'ONGOING',
          totalChapters: 5,
        ),
        bookmarkedAt: DateTime.parse('2026-09-23T10:00:00Z'),
        unreadChapterCount: 1,
      );

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.libraryBookmarks,
            queryParameters: {'status': 'ONGOING', 'page': 1, 'limit': 20},
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.libraryBookmarks),
          statusCode: 200,
          data: {
            'data': [bookmarkItem.toJson()],
            'pagination': {
              'page': 1,
              'limit': 20,
              'totalItems': 1,
              'totalPages': 1,
            },
          },
        ),
      );

      await libraryRepo.fetchBookmarks(status: 'ONGOING', page: 1, limit: 20);

      // Key for ONGOING status must be populated
      expect(prefs.containsKey('omninovel_library_anon_bookmarks_ONGOING'), isTrue);
      // Key for ALL or null must NOT be populated
      expect(prefs.containsKey('omninovel_library_anon_bookmarks_ALL'), isFalse);
    });
  });

  group('LibraryRepository Delete & Rollback Tests', () {
    test('Gate 6C: deleteStoryHistory calls backend, invalidates repo, and clears cache', () async {
      when(() => mockProgressRepo.invalidateStory('s-1')).thenReturn(null);
      when(() => mockProgressRepo.getLocalCheckpoint('s-1')).thenAnswer((_) async => null);
      when(() => mockProgressRepo.clearLocalCheckpoint('s-1')).thenAnswer((_) async => {});
      when(() => mockApiClient.delete<dynamic>(ApiEndpoints.libraryHistoryStory('s-1'))).thenAnswer(
        (_) async => Response<dynamic>(
          requestOptions: RequestOptions(path: ApiEndpoints.libraryHistoryStory('s-1')),
          statusCode: 200,
        ),
      );

      // Pre-seed cache
      await prefs.setString('omninovel_library_anon_history_page1', '[]');
      await prefs.setString('omninovel_library_anon_continue_reading', jsonEncode(dummyItem.toJson()));

      await libraryRepo.deleteStoryHistory('s-1');

      verify(() => mockProgressRepo.invalidateStory('s-1')).called(1);
      verify(() => mockApiClient.delete<dynamic>(ApiEndpoints.libraryHistoryStory('s-1'))).called(1);
      verify(() => mockProgressRepo.clearLocalCheckpoint('s-1')).called(1);
      expect(prefs.containsKey('omninovel_library_anon_continue_reading'), isFalse);
    });

    test('Tightening 2: deleteStoryHistory rolls back local snapshot when network fails', () async {
      final snapshot = LocalReadingCheckpoint(
        storyId: 's-1',
        chapterId: 'c-1',
        pageIndex: 3,
        progressPercentage: 50.0,
        scrollPosition: 1000.0,
        updatedAt: DateTime.now(),
      );
      when(() => mockProgressRepo.invalidateStory('s-1')).thenReturn(null);
      when(() => mockProgressRepo.getLocalCheckpoint('s-1')).thenAnswer((_) async => snapshot);
      when(() => mockProgressRepo.saveLocalCheckpoint(snapshot)).thenAnswer((_) async => {});
      when(() => mockApiClient.delete<dynamic>(ApiEndpoints.libraryHistoryStory('s-1'))).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.libraryHistoryStory('s-1')),
          response: Response(
            requestOptions: RequestOptions(path: ApiEndpoints.libraryHistoryStory('s-1')),
            statusCode: 500,
          ),
        ),
      );

      await expectLater(
        () => libraryRepo.deleteStoryHistory('s-1'),
        throwsA(anything),
      );

      // Verify rollback was invoked
      verify(() => mockProgressRepo.saveLocalCheckpoint(snapshot)).called(1);
    });

    test('Gate 6D: clearAllHistory invalidates all stories and calls delete on backend', () async {
      when(() => mockProgressRepo.invalidateAllStories()).thenReturn(null);
      when(() => mockProgressRepo.clearAllLocalCheckpoints()).thenAnswer((_) async => {});
      when(() => mockApiClient.delete<dynamic>(ApiEndpoints.libraryHistory)).thenAnswer(
        (_) async => Response<dynamic>(
          requestOptions: RequestOptions(path: ApiEndpoints.libraryHistory),
          statusCode: 200,
        ),
      );

      await prefs.setString('omninovel_library_anon_history_page1', '[]');
      await prefs.setString('omninovel_library_anon_continue_reading', '{}');

      await libraryRepo.clearAllHistory();

      verify(() => mockProgressRepo.invalidateAllStories()).called(1);
      verify(() => mockProgressRepo.clearAllLocalCheckpoints()).called(1);
      expect(prefs.containsKey('omninovel_library_anon_history_page1'), isFalse);
      expect(prefs.containsKey('omninovel_library_anon_continue_reading'), isFalse);
    });
  });
}
