/// Giao diện mỏng (thin interface) cung cấp thông tin dung lượng đĩa trống.
/// Giúp tách biệt logic Quota/Eviction khỏi các thư viện/platform-channel cụ thể.
abstract interface class DiskSpaceProvider {
  /// Trả về số byte còn trống (free disk space) của phân vùng chứa [path].
  Future<int> getFreeBytes(String path);
}

/// Triển khai mặc định của [DiskSpaceProvider] phục vụ môi trường runtime production.
/// Có thể nhận callback truy vấn qua MethodChannel hoặc filesystem provider.
class DefaultDiskSpaceProvider implements DiskSpaceProvider {
  final Future<int> Function(String path)? _providerFunc;

  const DefaultDiskSpaceProvider([this._providerFunc]);

  @override
  Future<int> getFreeBytes(String path) async {
    final func = _providerFunc;
    if (func != null) {
      return await func(path);
    }
    // Fallback runtime: 10 GB giả định khi chưa kết nối native platform channel,
    // đảm bảo hệ thống có thể chạy an toàn và có thể thay thế bằng native channel.
    return 10 * 1024 * 1024 * 1024;
  }
}

