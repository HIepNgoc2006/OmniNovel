// Model DTOs cho Gamification & Rewards (Phase 5C.5)

class UserProgression {
  final String userId;
  final int level;
  final String totalExp;
  final int currentLevelExp;
  final int nextLevelExp;
  final String omnicoinBalance;
  final int currentStreak;
  final int maxStreak;
  final String? lastCheckinDate;
  final bool hasCheckedInToday;
  final String rankTitle;
  final String activeThemeId;
  final String activeThemeName;
  final String? badgeIcon;
  final int progressPercent;
  final String serverDateVN;
  final String serverNow;
  final String nextCheckinAt;
  final int secondsUntilNextCheckin;

  const UserProgression({
    required this.userId,
    required this.level,
    required this.totalExp,
    required this.currentLevelExp,
    required this.nextLevelExp,
    required this.omnicoinBalance,
    required this.currentStreak,
    required this.maxStreak,
    this.lastCheckinDate,
    required this.hasCheckedInToday,
    required this.rankTitle,
    required this.activeThemeId,
    required this.activeThemeName,
    this.badgeIcon,
    required this.progressPercent,
    required this.serverDateVN,
    required this.serverNow,
    required this.nextCheckinAt,
    required this.secondsUntilNextCheckin,
  });

  factory UserProgression.fromJson(Map<String, dynamic> json) {
    final activeTheme = json['activeTheme'] as Map<String, dynamic>? ?? {};
    final progress = json['progress'] as Map<String, dynamic>? ?? {};

    return UserProgression(
      userId: json['userId']?.toString() ?? '',
      level: json['level'] as int? ?? 1,
      totalExp: json['totalExp']?.toString() ?? '0',
      currentLevelExp: progress['currentLevelExp'] as int? ?? 0,
      nextLevelExp: progress['nextLevelExp'] as int? ?? 100,
      omnicoinBalance: json['omnicoinBalance']?.toString() ?? '0',
      currentStreak: json['currentStreak'] as int? ?? json['streak'] as int? ?? 0,
      maxStreak: json['maxStreak'] as int? ?? 0,
      lastCheckinDate: json['lastCheckinDate'] as String?,
      hasCheckedInToday: json['hasCheckedInToday'] as bool? ?? false,
      rankTitle: json['rankTitle']?.toString() ?? activeTheme['rankTitle']?.toString() ?? 'Độc Giả',
      activeThemeId: activeTheme['id']?.toString() ?? 'DEFAULT',
      activeThemeName: activeTheme['name']?.toString() ?? 'Mặc Định',
      badgeIcon: activeTheme['badgeIcon'] as String?,
      progressPercent: progress['progressPercent'] as int? ?? 0,
      serverDateVN: json['serverDateVN']?.toString() ?? '',
      serverNow: json['serverNow']?.toString() ?? DateTime.now().toIso8601String(),
      nextCheckinAt: json['nextCheckinAt']?.toString() ?? '',
      secondsUntilNextCheckin: (json['secondsUntilNextCheckin'] as num?)?.toInt() ?? 0,
    );
  }
}

class CheckinResult {
  final bool alreadyCheckedIn;
  final String message;
  final int coinsEarned;
  final int expEarned;
  final int newStreak;
  final int maxStreak;
  final String? earnedBadgeId;
  final String totalExp;
  final String omnicoinBalance;
  final int level;

  const CheckinResult({
    required this.alreadyCheckedIn,
    required this.message,
    required this.coinsEarned,
    required this.expEarned,
    required this.newStreak,
    required this.maxStreak,
    this.earnedBadgeId,
    required this.totalExp,
    required this.omnicoinBalance,
    required this.level,
  });

  factory CheckinResult.fromJson(Map<String, dynamic> json) {
    return CheckinResult(
      alreadyCheckedIn: json['alreadyCheckedIn'] as bool? ?? false,
      message: json['message']?.toString() ?? '',
      coinsEarned: json['coinsEarned'] as int? ?? 0,
      expEarned: json['expEarned'] as int? ?? 0,
      newStreak: json['newStreak'] as int? ?? 0,
      maxStreak: json['maxStreak'] as int? ?? 0,
      earnedBadgeId: json['earnedBadgeId'] as String?,
      totalExp: json['totalExp']?.toString() ?? '0',
      omnicoinBalance: json['omnicoinBalance']?.toString() ?? '0',
      level: json['level'] as int? ?? 1,
    );
  }
}

class RankThemeItem {
  final String id;
  final String name;
  final String? description;
  final bool isActive;
  final String currentRankTitle;
  final String? badgeIcon;

  const RankThemeItem({
    required this.id,
    required this.name,
    this.description,
    required this.isActive,
    required this.currentRankTitle,
    this.badgeIcon,
  });

  factory RankThemeItem.fromJson(Map<String, dynamic> json) {
    return RankThemeItem(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      description: json['description'] as String?,
      isActive: json['isActive'] as bool? ?? true,
      currentRankTitle: json['currentRankTitle']?.toString() ?? 'Độc Giả',
      badgeIcon: json['badgeIcon'] as String?,
    );
  }
}

class MilestoneRewardItem {
  final String id;
  final int milestoneLevel;
  final int rewardCoins;
  final String? rewardBadgeId;
  final bool isClaimed;
  final bool canClaim;

  const MilestoneRewardItem({
    required this.id,
    required this.milestoneLevel,
    required this.rewardCoins,
    this.rewardBadgeId,
    required this.isClaimed,
    required this.canClaim,
  });

  factory MilestoneRewardItem.fromJson(Map<String, dynamic> json) {
    return MilestoneRewardItem(
      id: json['id']?.toString() ?? '',
      milestoneLevel: json['milestoneLevel'] as int? ?? 0,
      rewardCoins: json['rewardCoins'] as int? ?? 0,
      rewardBadgeId: json['rewardBadgeId'] as String?,
      isClaimed: json['isClaimed'] as bool? ?? false,
      canClaim: json['canClaim'] as bool? ?? false,
    );
  }
}

class RewardTransactionItem {
  final String id;
  final String rewardType;
  final int amount;
  final String balanceAfter;
  final String sourceType;
  final String? sourceId;
  final DateTime createdAt;

  const RewardTransactionItem({
    required this.id,
    required this.rewardType,
    required this.amount,
    required this.balanceAfter,
    required this.sourceType,
    this.sourceId,
    required this.createdAt,
  });

  factory RewardTransactionItem.fromJson(Map<String, dynamic> json) {
    return RewardTransactionItem(
      id: json['id']?.toString() ?? '',
      rewardType: json['rewardType']?.toString() ?? '',
      amount: json['amount'] as int? ?? 0,
      balanceAfter: json['balanceAfter']?.toString() ?? '0',
      sourceType: json['sourceType']?.toString() ?? '',
      sourceId: json['sourceId'] as String?,
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'].toString()) ?? DateTime.now()
          : DateTime.now(),
    );
  }
}

class ReadChapterRewardResult {
  final bool success;
  final int earnedExp;
  final String? reason;
  final String? message;
  final String? totalExp;
  final int? level;
  final int? todayTotalReadExp;
  final int? dailyCap;
  final String serverDateVN;

  const ReadChapterRewardResult({
    required this.success,
    required this.earnedExp,
    this.reason,
    this.message,
    this.totalExp,
    this.level,
    this.todayTotalReadExp,
    this.dailyCap,
    required this.serverDateVN,
  });

  factory ReadChapterRewardResult.fromJson(Map<String, dynamic> json) {
    return ReadChapterRewardResult(
      success: json['success'] as bool? ?? false,
      earnedExp: json['earnedExp'] as int? ?? 0,
      reason: json['reason'] as String?,
      message: json['message'] as String?,
      totalExp: json['totalExp']?.toString(),
      level: json['level'] as int?,
      todayTotalReadExp: json['todayTotalReadExp'] as int?,
      dailyCap: json['dailyCap'] as int?,
      serverDateVN: json['serverDateVN']?.toString() ?? '',
    );
  }
}
