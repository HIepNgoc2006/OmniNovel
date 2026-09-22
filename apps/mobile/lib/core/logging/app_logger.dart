import 'dart:developer' as developer;

class AppLogger {
  final String _tag;

  const AppLogger([this._tag = 'OmniNovel']);

  void d(String message) {
    developer.log(message, name: '$_tag:DEBUG');
  }

  void i(String message) {
    developer.log(message, name: '$_tag:INFO');
  }

  void w(String message, [Object? error, StackTrace? stackTrace]) {
    developer.log(message, name: '$_tag:WARN', error: error, stackTrace: stackTrace);
  }

  void e(String message, [Object? error, StackTrace? stackTrace]) {
    developer.log(message, name: '$_tag:ERROR', error: error, stackTrace: stackTrace);
  }
}
