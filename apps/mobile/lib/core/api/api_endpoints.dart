class ApiEndpoints {
  // Auth
  static const String login = '/auth/login';
  static const String register = '/auth/register';
  static const String refresh = '/auth/refresh';
  static const String logout = '/auth/logout';
  static const String me = '/auth/me';

  // Stories & Catalog
  static const String stories = '/stories';
  static String storyDetails(String id) => '/stories/$id';
  static String chapterDetails(String id) => '/chapters/$id';

  // Library & Reading Progress
  static const String readingProgress = '/library/reading-progress';
  static String storyReadingProgress(String storyId) => '/library/reading-progress/$storyId';

  // Chapter Reporting (Issue #191)
  static String chapterReport(String chapterId) => '/chapters/$chapterId/reports';
}
