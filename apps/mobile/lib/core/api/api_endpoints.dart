class ApiEndpoints {
  // Auth
  static const String login = '/auth/login';
  static const String register = '/auth/register';
  static const String refresh = '/auth/refresh';
  static const String logout = '/auth/logout';
  static const String me = '/auth/me';

  // Stories & Catalog
  static const String stories = '/stories';
  static const String storiesFeatured = '/stories/featured';
  static const String storiesRankings = '/stories/rankings';
  static const String genres = '/genres';
  static String storyDetails(String id) => '/stories/$id';
  static String storyBySlug(String slug) => '/stories/$slug';
  static String chapterDetails(String id) => '/chapters/$id';

  // Storage & Media (Presigned URL)
  static String mediaUrl(String assetId) => '/storage/media-url/$assetId';

  // Library & Reading Progress
  static const String readingProgress = '/library/reading-progress';
  static String storyReadingProgress(String storyId) => '/library/reading-progress/$storyId';
  static const String libraryBookmarks = '/library/bookmarks';
  static String storyBookmarkStatus(String storyId) => '/library/bookmarks/$storyId';
  static const String libraryHistory = '/library/history';
  static String libraryHistoryStory(String storyId) => '/library/history/$storyId';

  // Chapter Reporting (Issue #191)
  static String chapterReport(String chapterId) => '/chapters/$chapterId/reports';

  // Gamification & Rewards (Phase 5C.5)
  static const String gamificationProgression = '/gamification/progression';
  static const String gamificationCheckin = '/gamification/checkin';
  static const String gamificationThemes = '/gamification/themes';
  static const String gamificationRankTheme = '/gamification/rank-theme';
  static const String gamificationRewards = '/gamification/rewards';
  static const String gamificationRewardsClaim = '/gamification/rewards/claim';
  static const String gamificationTransactions = '/gamification/transactions';
  static const String gamificationReadChapter = '/gamification/read-chapter';
  static const String gamificationLeaderboard = '/gamification/leaderboard';

  // Studio AI Translation (Phase 5D.7)
  static const String aiJobs = '/ai/jobs';
  static String aiJobDetail(String id) => '/ai/jobs/$id';
  static String aiJobPreviews(String id) => '/ai/jobs/$id/previews';
  static String aiJobSegments(String id) => '/ai/jobs/$id/segments';
  static String aiJobApply(String id) => '/ai/jobs/$id/apply';

  // Guest Claim (Phase 7B.3)
  static const String guestClaimPrepare = '/account/guest-claims/prepare';
  static String guestClaimCommit(String claimId) => '/account/guest-claims/$claimId/commit';
  static String guestClaimStatus(String claimId) => '/account/guest-claims/$claimId/status';
}
