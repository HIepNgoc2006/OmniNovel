import 'dart:async';
import 'dart:math' as math;
import 'package:dio/dio.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/api_error.dart';
import '../../../core/theme/theme_controller.dart';
import '../models/gamification_models.dart';

/// Repository quản lý dữ liệu Gamification & Rewards
/// Hỗ trợ SWR Caching phân lập theo user, Single-flight Mutex, và Uncertain Outcome Revalidation.
class GamificationRepository {
  final ApiClient _apiClient;
  final ThemeController? _themeController;

  String _generateIdempotencyKey() =>
      '${DateTime.now().microsecondsSinceEpoch}-${math.Random().nextInt(1000000)}';

  // In-memory SWR Cache
  final Map<String, UserProgression> _progressionCache = {};
  final Map<String, List<MilestoneRewardItem>> _rewardsCache = {};
  List<RankThemeItem>? _themesCache;

  // Single-flight in-flight guards
  bool _isCheckingIn = false;
  final Set<int> _claimingLevels = {};

  GamificationRepository({
    required ApiClient apiClient,
    ThemeController? themeController,
  })  : _apiClient = apiClient,
        _themeController = themeController;

  /// Lấy thông tin chi tiết tiến trình độc giả kèm SWR Cache
  Future<UserProgression> getProgression({
    bool forceRefresh = false,
    String? userId,
  }) async {
    final effectiveUserId = userId ?? _themeController?.activeUserId ?? 'default';

    if (!forceRefresh && _progressionCache.containsKey(effectiveUserId)) {
      return _progressionCache[effectiveUserId]!;
    }

    final response = await _apiClient.get<Map<String, dynamic>>(
      ApiEndpoints.gamificationProgression,
    );

    final progression = UserProgression.fromJson(response.data!);
    _progressionCache[effectiveUserId] = progression;

    // Tự động đồng bộ theme từ server nếu có ThemeController
    await _themeController?.reconcileFromServer(progression.activeThemeId);

    return progression;
  }

  /// Điểm danh hàng ngày kèm Client Single-Flight & Uncertain Outcome Revalidation
  Future<CheckinResult> checkIn({String? userId, String? idempotencyKey}) async {
    final effectiveUserId = userId ?? _themeController?.activeUserId ?? 'default';

    if (_isCheckingIn) {
      throw const ApiError(
        code: 'CHECKIN_REQUEST_IN_FLIGHT',
        statusCode: 400,
        message: 'Yêu cầu điểm danh đang được xử lý, vui lòng chờ trong giây lát.',
      );
    }

    _isCheckingIn = true;
    final key = idempotencyKey ?? _generateIdempotencyKey();

    try {
      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.gamificationCheckin,
        options: Options(headers: {'idempotency-key': key}),
      );

      final result = CheckinResult.fromJson(response.data!);

      // Luôn làm tươi tiến trình để lấy countdown và streak mới nhất
      await getProgression(userId: effectiveUserId, forceRefresh: true);

      return result;
    } on ApiError catch (e) {
      // Khi gặp CHECKIN_REQUEST_IN_FLIGHT hoặc Timeout -> Revalidate để phục hồi state
      if (e.message.contains('CHECKIN_REQUEST_IN_FLIGHT') || e.statusCode == 408) {
        await getProgression(userId: effectiveUserId, forceRefresh: true);
      }
      rethrow;
    } finally {
      _isCheckingIn = false;
    }
  }

  /// Lấy danh sách 6 Rank Themes active
  Future<List<RankThemeItem>> getThemes({bool forceRefresh = false}) async {
    if (!forceRefresh && _themesCache != null) {
      return _themesCache!;
    }

    final response = await _apiClient.get<Map<String, dynamic>>(
      ApiEndpoints.gamificationThemes,
    );

    final rawThemes = response.data?['themes'] as List? ?? [];
    final themes = rawThemes
        .map((t) => RankThemeItem.fromJson(t as Map<String, dynamic>))
        .toList();

    _themesCache = themes;
    return themes;
  }

  /// Lấy danh sách Milestone Rewards kèm trạng thái isClaimed và canClaim
  Future<List<MilestoneRewardItem>> getLevelRewards({
    bool forceRefresh = false,
    String? userId,
  }) async {
    final effectiveUserId = userId ?? _themeController?.activeUserId ?? 'default';

    if (!forceRefresh && _rewardsCache.containsKey(effectiveUserId)) {
      return _rewardsCache[effectiveUserId]!;
    }

    final response = await _apiClient.get<Map<String, dynamic>>(
      ApiEndpoints.gamificationRewards,
    );

    final rawRewards = response.data?['rewards'] as List? ?? [];
    final rewards = rawRewards
        .map((r) => MilestoneRewardItem.fromJson(r as Map<String, dynamic>))
        .toList();

    _rewardsCache[effectiveUserId] = rewards;
    return rewards;
  }

  /// Nhận phần thưởng mốc cấp độ với Single-Flight Guard & Uncertain Outcome Revalidation
  Future<void> claimLevelReward(
    int milestoneLevel, {
    String? idempotencyKey,
  }) async {
    if (_claimingLevels.contains(milestoneLevel)) {
      throw const ApiError(
        code: 'LEVEL_REWARD_REQUEST_IN_FLIGHT',
        statusCode: 400,
        message: 'Yêu cầu nhận thưởng mốc này đang được xử lý.',
      );
    }

    _claimingLevels.add(milestoneLevel);
    final key = idempotencyKey ?? _generateIdempotencyKey();

    try {
      await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.gamificationRewardsClaim,
        data: {'milestoneLevel': milestoneLevel},
        options: Options(headers: {'idempotency-key': key}),
      );

      // Cập nhật lại state sau khi nhận thưởng thành công
      await Future.wait([
        getLevelRewards(forceRefresh: true),
        getProgression(forceRefresh: true),
      ]);
    } on ApiError catch (e) {
      if (e.message.contains('LEVEL_REWARD_REQUEST_IN_FLIGHT') || e.statusCode == 408) {
        await Future.wait([
          getLevelRewards(forceRefresh: true),
          getProgression(forceRefresh: true),
        ]);
      }
      rethrow;
    } finally {
      _claimingLevels.remove(milestoneLevel);
    }
  }

  /// Thay đổi Rank Theme trên server
  Future<void> changeRankTheme(String themeId) async {
    await _apiClient.patch<Map<String, dynamic>>(
      ApiEndpoints.gamificationRankTheme,
      data: {'themeId': themeId},
    );

    await getProgression(forceRefresh: true);
  }

  /// Gửi yêu cầu nhận thưởng EXP khi đọc xong chương
  Future<ReadChapterRewardResult> rewardReadChapter({
    required String chapterId,
    required int readingDurationSeconds,
    required double progressPercentage,
  }) async {
    final response = await _apiClient.post<Map<String, dynamic>>(
      ApiEndpoints.gamificationReadChapter,
      data: {
        'chapterId': chapterId,
        'readingDurationSeconds': readingDurationSeconds,
        'progressPercentage': progressPercentage,
      },
    );

    return ReadChapterRewardResult.fromJson(response.data!);
  }

  /// Lấy lịch sử giao dịch Sổ Cái
  Future<List<RewardTransactionItem>> getTransactions({
    int page = 1,
    int limit = 20,
    String? rewardType,
  }) async {
    final queryParams = <String, dynamic>{
      'page': page,
      'limit': limit,
    };
    if (rewardType != null) {
      queryParams['rewardType'] = rewardType;
    }

    final response = await _apiClient.get<Map<String, dynamic>>(
      ApiEndpoints.gamificationTransactions,
      queryParameters: queryParams,
    );

    final rawTx = response.data?['transactions'] as List? ?? [];
    return rawTx
        .map((t) => RewardTransactionItem.fromJson(t as Map<String, dynamic>))
        .toList();
  }

  /// Xóa cache khi user logout
  void clearCache() {
    _progressionCache.clear();
    _rewardsCache.clear();
    _themesCache = null;
    _isCheckingIn = false;
    _claimingLevels.clear();
  }
}
