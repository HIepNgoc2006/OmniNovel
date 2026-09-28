import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/features/studio/models/studio_models.dart';
import 'package:omninovel_mobile/features/studio/models/studio_presentation_models.dart';
import 'package:omninovel_mobile/features/studio/repositories/studio_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient mockApiClient;
  late StudioRepository repository;

  setUp(() {
    mockApiClient = MockApiClient();
    repository = StudioRepository(apiClient: mockApiClient);
  });

  group('Gate 1: Canonical Contract Parity & StudioRepository Tests', () {
    test('getJobDetail parses TranslationJobReviewDetailResponse correctly and checks isFresh', () async {
      final mockData = <String, dynamic>{
        'job': {
          'id': 'job-uuid-1',
          'status': 'READY_FOR_REVIEW',
          'progressPercentage': 100,
          'provider': 'OPENAI',
          'modelName': 'gpt-4o',
          'promptVersion': 'v1.2',
          'attemptCount': 1,
          'maxAttempts': 3,
          'createdAt': '2026-09-28T12:00:00.000Z',
          'startedAt': '2026-09-28T12:00:05.000Z',
          'completedAt': '2026-09-28T12:05:00.000Z',
          'reviewRevision': 2,
          'materializedRevision': 2,
          'workspaceRevision': 5,
        },
        'context': {
          'story': {
            'id': 'story-uuid-1',
            'title': 'OmniNovel Manga',
            'slug': 'omninovel-manga',
            'mediaFormat': 'COMIC',
          },
          'edition': {
            'id': 'edition-uuid-1',
            'editionName': 'Vietnamese Edition',
            'language': 'vi',
            'isDefault': true,
          },
          'chapter': {
            'id': 'chapter-uuid-1',
            'chapterNumber': '10',
            'title': 'Chapter 10 Title',
          },
          'project': {
            'id': 'project-uuid-1',
            'sourceLanguage': 'ja',
            'targetLanguage': 'vi',
          },
          'sourceVersion': {'id': 'src-ver-1', 'versionNumber': 1},
          'targetVersion': {'id': 'tgt-ver-1', 'versionNumber': 2},
        },
        'reviewSummary': {
          'segmentCount': 42,
          'verifiedCount': 42,
          'pageCount': 15,
          'resultPageCount': 15,
          'blockCount': null,
        },
        'permissions': {
          'canApply': true,
        },
        'glossarySnapshot': [
          {'sourceTerm': 'Senpai', 'targetTerm': 'Tiền bối', 'category': 'honorific'},
        ],
      };

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.aiJobDetail('job-uuid-1'))).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.aiJobDetail('job-uuid-1')),
          statusCode: 200,
          data: mockData,
        ),
      );

      final detail = await repository.getJobDetail('job-uuid-1');

      expect(detail.job.id, 'job-uuid-1');
      expect(detail.job.status, TranslationJobStatus.readyForReview);
      expect(detail.context.story.mediaFormat, MediaFormat.comic);
      expect(detail.context.chapter.chapterNumber, '10');
      expect(detail.reviewSummary.segmentCount, 42);
      expect(detail.permissions.canApply, true);
      expect(detail.permissions.applyBlockReason, isNull);
      expect(detail.isFresh, isTrue); // reviewRevision 2 == materializedRevision 2
      expect(detail.glossarySnapshot?.first.sourceTerm, 'Senpai');
    });

    test('isFresh returns false when reviewRevision does not match materializedRevision (stale artifact)', () async {
      final mockData = <String, dynamic>{
        'job': {
          'id': 'job-uuid-stale',
          'status': 'READY_FOR_REVIEW',
          'reviewRevision': 3,
          'materializedRevision': 2,
          'workspaceRevision': 6,
        },
        'context': {
          'story': {'id': 's1', 'title': 'T', 'slug': 's', 'mediaFormat': 'NOVEL'},
          'edition': {'id': 'e1', 'editionName': 'E', 'language': 'vi', 'isDefault': true},
          'chapter': {'id': 'c1', 'chapterNumber': '1'},
          'project': {'id': 'p1', 'sourceLanguage': 'en', 'targetLanguage': 'vi'},
          'sourceVersion': {'id': 'v1', 'versionNumber': 1},
        },
        'reviewSummary': {'segmentCount': 10, 'verifiedCount': 5},
        'permissions': {'canApply': true},
      };

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.aiJobDetail('job-uuid-stale'))).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.aiJobDetail('job-uuid-stale')),
          statusCode: 200,
          data: mockData,
        ),
      );

      final detail = await repository.getJobDetail('job-uuid-stale');
      expect(detail.isFresh, isFalse);
    });

    test('getPreviews returns TranslationJobPreviewsResponse and parses assets', () async {
      final mockData = <String, dynamic>{
        'workspaceRevision': 4,
        'sourceAssets': [
          {
            'kind': 'SOURCE_REVIEW',
            'pageNumber': 1,
            'width': 800,
            'height': 1200,
            'url': 'https://minio/source/page1.jpg',
          },
          {
            'kind': 'SOURCE_REVIEW',
            'pageNumber': 2,
            'width': 800,
            'height': 1200,
            'url': 'https://minio/source/page2.jpg',
          },
        ],
        'resultAssets': [
          {
            'kind': 'RESULT',
            'pageNumber': 1,
            'width': 800,
            'height': 1200,
            'url': 'https://minio/result/page1.png',
            'fileSizeBytes': 1048576,
          },
          {
            'kind': 'RESULT',
            'pageNumber': 2,
            'width': 800,
            'height': 1200,
            'url': 'https://minio/result/page2.png',
            'fileSizeBytes': 1048576,
          },
        ],
      };

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.aiJobPreviews('job-uuid-1'),
            queryParameters: {'fromPage': 1, 'toPage': 2},
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.aiJobPreviews('job-uuid-1')),
          statusCode: 200,
          data: mockData,
        ),
      );

      final previews = await repository.getPreviews('job-uuid-1', fromPage: 1, toPage: 2);

      expect(previews.workspaceRevision, 4);
      expect(previews.sourceAssets.length, 2);
      expect(previews.resultAssets.length, 2);
      expect(previews.resultAssets.first.fileSizeBytes, 1048576);

      // Verify MangaPreviewPair presentation mapping
      final pairs = MangaPreviewPair.fromPreviewsResponse(previews);
      expect(pairs.length, 2);
      expect(pairs[0].pageNumber, 1);
      expect(pairs[0].hasBoth, isTrue);
      expect(pairs[0].sourceAsset?.url, 'https://minio/source/page1.jpg');
      expect(pairs[0].resultAsset?.url, 'https://minio/result/page1.png');
    });

    test('getSegments returns paginated TranslationJobSegmentsResponse with rawText and translatedText', () async {
      final mockData = <String, dynamic>{
        'workspaceRevision': 3,
        'total': 1,
        'page': 1,
        'limit': 50,
        'totalPages': 1,
        'data': [
          {
            'id': 'segment-1',
            'jobId': 'job-uuid-novel',
            'pageNumber': null,
            'anchorBlockId': 'block-101',
            'sortOrder': 1,
            'rawText': 'Hello World',
            'translatedText': 'Xin chào Thế giới',
            'confidence': 0.98,
            'isHumanVerified': true,
            'version': 1,
          }
        ],
      };

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.aiJobSegments('job-uuid-novel'),
            queryParameters: {'page': 1, 'limit': 50},
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.aiJobSegments('job-uuid-novel')),
          statusCode: 200,
          data: mockData,
        ),
      );

      final segments = await repository.getSegments('job-uuid-novel', page: 1, limit: 50);

      expect(segments.data.length, 1);
      final seg = segments.data.first;
      expect(seg.rawText, 'Hello World');
      expect(seg.translatedText, 'Xin chào Thế giới');
      expect(seg.isHumanVerified, isTrue);
      expect(seg.anchorBlockId, 'block-101');
    });

    test('applyJob sends Idempotency-Key header and mode body correctly', () async {
      final mockResponse = <String, dynamic>{
        'chapterId': 'chap-10',
        'activeVersionId': 'ver-new',
        'targetVersionId': 'ver-new',
        'versionNumber': 3,
        'versionType': 'TRANSLATED',
        'isAlreadyApplied': false,
      };

      const testIdempotencyKey = '550e8400-e29b-41d4-a716-446655440000';

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.aiJobApply('job-uuid-1'),
            data: {'mode': 'OVERWRITE_ACTIVE_VERSION'},
            options: any(named: 'options'),
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.aiJobApply('job-uuid-1')),
          statusCode: 200,
          data: mockResponse,
        ),
      );

      final result = await repository.applyJob(
        'job-uuid-1',
        const ApplyTranslationJobRequest(mode: ApplyTranslationMode.overwriteActiveVersion),
        idempotencyKey: testIdempotencyKey,
      );

      final captured = verify(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.aiJobApply('job-uuid-1'),
            data: {'mode': 'OVERWRITE_ACTIVE_VERSION'},
            options: captureAny(named: 'options'),
          )).captured;
      final capturedOptions = captured.first as Options;
      expect(capturedOptions.headers?['Idempotency-Key'], testIdempotencyKey);

      expect(result.chapterId, 'chap-10');
      expect(result.targetVersionId, 'ver-new');
      expect(result.versionNumber, 3);
      expect(result.isAlreadyApplied, isFalse);
    });

    test('getAllReadyForReviewJobs paginates completely and getJobsByChapterForStory groups correctly', () async {
      // Page 1: totalPages = 2, returns job 1 and job 2
      final page1Response = <String, dynamic>{
        'total': 3,
        'page': 1,
        'limit': 100,
        'totalPages': 2,
        'data': [
          {
            'id': 'job-1',
            'chapterId': 'chap-1',
            'chapterNumber': '1',
            'status': 'READY_FOR_REVIEW',
            'targetLanguage': 'vi',
            'modelName': 'gpt-4o',
            'createdAt': '2026-09-28T10:00:00.000Z',
          },
          {
            'id': 'job-2',
            'chapterId': 'chap-1', // same chapter (multi-job)
            'chapterNumber': '1',
            'status': 'READY_FOR_REVIEW',
            'targetLanguage': 'en',
            'modelName': 'claude-3-5-sonnet',
            'createdAt': '2026-09-28T09:00:00.000Z',
          },
        ],
      };

      // Page 2: totalPages = 2, returns job 3 for chapter 2
      final page2Response = <String, dynamic>{
        'total': 3,
        'page': 2,
        'limit': 100,
        'totalPages': 2,
        'data': [
          {
            'id': 'job-3',
            'chapterId': 'chap-2',
            'chapterNumber': '2',
            'status': 'READY_FOR_REVIEW',
            'targetLanguage': 'vi',
            'modelName': 'gpt-4o',
            'createdAt': '2026-09-28T08:00:00.000Z',
          },
        ],
      };

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.aiJobs,
            queryParameters: {
              'storyId': 'story-1',
              'status': 'READY_FOR_REVIEW',
              'page': 1,
              'limit': 100,
            },
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.aiJobs),
          statusCode: 200,
          data: page1Response,
        ),
      );

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.aiJobs,
            queryParameters: {
              'storyId': 'story-1',
              'status': 'READY_FOR_REVIEW',
              'page': 2,
              'limit': 100,
            },
          )).thenAnswer(
        (_) async => Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.aiJobs),
          statusCode: 200,
          data: page2Response,
        ),
      );

      final map = await repository.getJobsByChapterForStory('story-1');

      expect(map.keys.length, 2);
      expect(map['chap-1']?.length, 2);
      expect(map['chap-1']?[0].id, 'job-1');
      expect(map['chap-1']?[1].id, 'job-2');
      expect(map['chap-2']?.length, 1);
      expect(map['chap-2']?[0].id, 'job-3');
    });
  });
}
