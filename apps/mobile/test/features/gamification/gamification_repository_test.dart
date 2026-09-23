import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/errors/api_error.dart';
import 'package:omninovel_mobile/features/gamification/repositories/gamification_repository.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  setUpAll(() {
    registerFallbackValue(Options());
  });

  late MockApiClient mockApiClient;
  late GamificationRepository repository;

  setUp(() {
    mockApiClient = MockApiClient();
    repository = GamificationRepository(apiClient: mockApiClient);
  });

  group('GamificationRepository SWR Cache Tests', () {
    final mockProgressionData = <String, dynamic>{
      'userId': 'user-1',
      'level': 5,
      'totalExp': '450',
      'progress': {
        'currentLevelExp': 450,
        'nextLevelExp': 1000,
        'progressPercent': 45,
      },
      'omnicoinBalance': '1250',
      'currentStreak': 3,
      'maxStreak': 7,
      'lastCheckinDate': '2026-09-23',
      'serverDateVN': '2026-09-24',
      'serverNow': '2026-09-24T00:00:00.000Z',
      'nextCheckinAt': '2026-09-24T17:00:00.000Z',
      'secondsUntilNextCheckin': 61200,
      'activeTheme': {
        'id': 'TU_TIEN',
        'name': 'Tu Tiên',
        'rankTitle': 'Trúc Cơ',
      },
      'hasCheckedInToday': false,
    };

    test('getProgression caches per userId and forceRefresh invalidates cache', () async {
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression))
          .thenAnswer((_) async => Response<Map<String, dynamic>>(
                requestOptions: RequestOptions(path: ApiEndpoints.gamificationProgression),
                statusCode: 200,
                data: mockProgressionData,
              ));

      // First call (cache miss)
      final p1 = await repository.getProgression(userId: 'user-1');
      expect(p1.userId, 'user-1');
      expect(p1.omnicoinBalance, '1250');
      expect(p1.serverDateVN, '2026-09-24');

      // Second call without forceRefresh (cache hit)
      final p2 = await repository.getProgression(userId: 'user-1');
      expect(identical(p1, p2), isTrue);
      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression)).called(1);

      // Call for different userId: cache miss for user-2
      final user2Data = Map<String, dynamic>.from(mockProgressionData);
      user2Data['userId'] = 'user-2';
      user2Data['omnicoinBalance'] = '500';
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression))
          .thenAnswer((_) async => Response<Map<String, dynamic>>(
                requestOptions: RequestOptions(path: ApiEndpoints.gamificationProgression),
                statusCode: 200,
                data: user2Data,
              ));

      final pUser2 = await repository.getProgression(userId: 'user-2');
      expect(pUser2.userId, 'user-2');
      expect(pUser2.omnicoinBalance, '500');
      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression)).called(1);

      // Call with forceRefresh for user-1
      await repository.getProgression(userId: 'user-1', forceRefresh: true);
      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression)).called(1);
    });

    test('single-flight checkIn prevents concurrent calls and invalidates user cache', () async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.gamificationCheckin,
            options: any(named: 'options'),
          )).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        return Response<Map<String, dynamic>>(
          requestOptions: RequestOptions(path: ApiEndpoints.gamificationCheckin),
          statusCode: 200,
          data: <String, dynamic>{
            'alreadyCheckedIn': false,
            'message': 'Điểm danh thành công',
            'newStreak': 4,
            'maxStreak': 5,
            'expEarned': 50,
            'coinsEarned': 10,
            'totalExp': '500',
            'omnicoinBalance': '1260',
            'level': 5,
          },
        );
      });

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression))
          .thenAnswer((_) async => Response<Map<String, dynamic>>(
                requestOptions: RequestOptions(path: ApiEndpoints.gamificationProgression),
                statusCode: 200,
                data: mockProgressionData,
              ));

      // Launch first check-in (in-flight)
      final future1 = repository.checkIn(userId: 'user-1');
      // Second concurrent check-in should immediately throw
      expect(
        () => repository.checkIn(userId: 'user-1'),
        throwsA(isA<ApiError>()),
      );

      final res1 = await future1;
      expect(res1.alreadyCheckedIn, isFalse);
      expect(res1.newStreak, 4);

      // Only 1 API call should have been dispatched
      verify(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.gamificationCheckin,
            options: any(named: 'options'),
          )).called(1);
    });

    test('checkIn handles CHECKIN_REQUEST_IN_FLIGHT by revalidating progression', () async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.gamificationCheckin,
            options: any(named: 'options'),
          )).thenThrow(
        const ApiError(
          statusCode: 409,
          code: 'CHECKIN_REQUEST_IN_FLIGHT',
          message: 'CHECKIN_REQUEST_IN_FLIGHT: Request in flight',
        ),
      );

      final updatedProgression = Map<String, dynamic>.from(mockProgressionData);
      updatedProgression['hasCheckedInToday'] = true;
      updatedProgression['currentStreak'] = 4;
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression))
          .thenAnswer((_) async => Response<Map<String, dynamic>>(
                requestOptions: RequestOptions(path: ApiEndpoints.gamificationProgression),
                statusCode: 200,
                data: updatedProgression,
              ));

      expect(
        () => repository.checkIn(userId: 'user-1'),
        throwsA(isA<ApiError>()),
      );
      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression)).called(1);
    });

    test('claimLevelReward handles LEVEL_REWARD_REQUEST_IN_FLIGHT by revalidating', () async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.gamificationRewardsClaim,
            data: any<dynamic>(named: 'data'),
            options: any<Options>(named: 'options'),
          )).thenThrow(
        const ApiError(
          statusCode: 409,
          code: 'LEVEL_REWARD_REQUEST_IN_FLIGHT',
          message: 'LEVEL_REWARD_REQUEST_IN_FLIGHT: Claim in flight',
        ),
      );

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression))
          .thenAnswer((_) async => Response<Map<String, dynamic>>(
                requestOptions: RequestOptions(path: ApiEndpoints.gamificationProgression),
                statusCode: 200,
                data: mockProgressionData,
              ));
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationRewards))
          .thenAnswer((_) async => Response<Map<String, dynamic>>(
                requestOptions: RequestOptions(path: ApiEndpoints.gamificationRewards),
                statusCode: 200,
                data: <String, dynamic>{'rewards': <Map<String, dynamic>>[]},
              ));

      expect(
        () => repository.claimLevelReward(5),
        throwsA(isA<ApiError>()),
      );
      verify(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.gamificationProgression)).called(1);
    });

    test('rewardReadChapter passes required serverDateVN for all outcomes', () async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.gamificationReadChapter,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.gamificationReadChapter),
            statusCode: 200,
            data: <String, dynamic>{
              'success': false,
              'earnedExp': 0,
              'reason': 'DAILY_CAP_REACHED',
              'serverDateVN': '2026-09-24',
              'message': 'Đã đạt giới hạn EXP đọc truyện hôm nay (100/100).',
            },
          ));

      final result = await repository.rewardReadChapter(
        chapterId: 'chap-10',
        readingDurationSeconds: 60,
        progressPercentage: 85,
      );

      expect(result.success, isFalse);
      expect(result.reason, 'DAILY_CAP_REACHED');
      expect(result.serverDateVN, '2026-09-24');
    });
  });
}
