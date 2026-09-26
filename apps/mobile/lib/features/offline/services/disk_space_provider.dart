/// Giao diện mỏng (thin interface) cung cấp thông tin dung lượng đĩa trống.
/// Giúp tách biệt logic Quota/Eviction khỏi các thư viện/platform-channel cụ thể.
abstract interface class DiskSpaceProvider {
  /// Trả về số byte còn trống (free disk space) của phân vùng chứa [path].
  Future<int> getFreeBytes(String path);
}
