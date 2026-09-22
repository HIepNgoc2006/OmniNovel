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
  static String storyDetails(String id) => '/stories/$id';
  static String storyBySlug(String slug) => '/stories/$slug';
  static String chapterDetails(String id) => '/chapters/$id';

  // Storage & Media (Presigned URL)
  static String mediaUrl(String assetId) => '/storage/media-url/$assetId';

  // Library & Reading Progress
  static const String readingProgress = '/library/reading-progress';
  static String storyReadingProgress(String storyId) => '/library/reading-progress/$storyId';

  // Chapter Reporting (Issue #191)
  static String chapterReport(String chapterId) => '/chapters/$chapterId/reports';
}
