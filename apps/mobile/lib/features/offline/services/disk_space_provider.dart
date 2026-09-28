import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Exception ném ra khi không thể xác định dung lượng đĩa trống từ hệ thống (fail-closed).
class DiskSpaceUnavailableException implements Exception {
  final String message;
  final Object? cause;

  const DiskSpaceUnavailableException(this.message, [this.cause]);

  @override
  String toString() =>
      'DiskSpaceUnavailableException: $message${cause != null ? ' (Cause: $cause)' : ''}';
}

/// Giao diện mỏng (thin interface) cung cấp thông tin dung lượng đĩa trống.
/// Giúp tách biệt logic Quota/Eviction khỏi các thư viện/platform-channel cụ thể.
abstract interface class DiskSpaceProvider {
  /// Trả về số byte còn trống (free disk space) của phân vùng chứa [path].
  /// Ném [DiskSpaceUnavailableException] nếu không thể lấy thông tin thực tế từ hệ điều hành (fail-closed).
  Future<int> getFreeBytes(String path);
}

/// Triển khai mặc định của [DiskSpaceProvider] phục vụ môi trường runtime production.
/// Ưu tiên [_providerFunc] (nếu được inject trong test/mock), sau đó gọi native platform channel [defaultChannelName].
/// Nếu platform channel không phản hồi, bị lỗi, hoặc trả về <= 0, hệ thống sẽ fail-closed bằng cách
/// ném [DiskSpaceUnavailableException], tuyệt đối không fallback con số giả định (như 10 GB).
class DefaultDiskSpaceProvider implements DiskSpaceProvider {
  static const String defaultChannelName = 'com.omninovel.mobile/disk_space';

  final Future<int> Function(String path)? _providerFunc;
  final MethodChannel _channel;

  const DefaultDiskSpaceProvider([
    this._providerFunc,
  ]) : _channel = const MethodChannel(defaultChannelName);

  @visibleForTesting
  DefaultDiskSpaceProvider.withChannel(
    MethodChannel channel, [
    this._providerFunc,
  ]) : _channel = channel;

  @override
  Future<int> getFreeBytes(String path) async {
    final func = _providerFunc;
    if (func != null) {
      final bytes = await func(path);
      if (bytes < 0) {
        throw DiskSpaceUnavailableException(
          'Custom provider returned invalid negative free bytes: $bytes for path $path',
        );
      }
      return bytes;
    }

    try {
      final dynamic result = await _channel.invokeMethod('getFreeDiskSpace', {'path': path});
      if (result is num && result >= 0) {
        return result.toInt();
      }
      throw DiskSpaceUnavailableException(
        'Platform channel returned invalid or negative free disk space: $result',
      );
    } on PlatformException catch (e) {
      throw DiskSpaceUnavailableException(
        'Native platform failure while querying available disk space for path $path: ${e.message}',
        e,
      );
    } on MissingPluginException catch (e) {
      throw DiskSpaceUnavailableException(
        'No native implementation found for disk space platform channel ($defaultChannelName). '
        'Fail-closed enforced to prevent unmonitored disk exhaustion.',
        e,
      );
    } catch (e) {
      if (e is DiskSpaceUnavailableException) rethrow;
      throw DiskSpaceUnavailableException(
        'Unexpected error while querying available disk space for path $path: $e',
        e,
      );
    }
  }
}

