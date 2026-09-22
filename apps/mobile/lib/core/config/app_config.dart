enum Environment {
  dev,
  test,
  prod,
}

class AppConfig {
  final Environment environment;
  final String apiBaseUrl;
  final Duration connectTimeout;
  final Duration receiveTimeout;
  final Duration sendTimeout;

  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    this.connectTimeout = const Duration(seconds: 15),
    this.receiveTimeout = const Duration(seconds: 15),
    this.sendTimeout = const Duration(seconds: 15),
  });

  static AppConfig? _instance;
  static AppConfig get instance {
    if (_instance == null) {
      throw StateError('AppConfig has not been initialized. Call initialize() first.');
    }
    return _instance!;
  }

  static void initialize({
    Environment environment = Environment.dev,
    String? customBaseUrl,
  }) {
    final baseUrl = customBaseUrl ??
        const String.fromEnvironment(
          'API_BASE_URL',
          defaultValue: '',
        );

    final resolvedBaseUrl = baseUrl.isNotEmpty
        ? baseUrl
        : switch (environment) {
            Environment.dev => 'http://10.0.2.2:8000/api/v1',
            Environment.test => 'http://localhost:8000/api/v1',
            Environment.prod => 'https://api.omninovel.com/api/v1',
          };

    _instance = AppConfig(
      environment: environment,
      apiBaseUrl: resolvedBaseUrl,
    );
  }

  static void setForTesting(AppConfig config) {
    _instance = config;
  }
}
