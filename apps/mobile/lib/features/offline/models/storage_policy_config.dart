/// Cấu hình chính sách lưu trữ và hạn mức bộ nhớ đệm ngoại tuyến (Data-only, injectable).
class StoragePolicyConfig {
  /// Mức dung lượng đĩa trống tối thiểu của thiết bị cần được bảo toàn (Headroom).
  /// Mặc định: 500 MB (500 * 1024 * 1024 = 524,288,000 bytes).
  final int minFreeDiskHeadroomBytes;

  /// Hạn mức tối đa dung lượng tải về của ứng dụng/người dùng (Quota).
  /// null nghĩa là không giới hạn hạn mức riêng (chỉ phụ thuộc vào headroom của thiết bị).
  final int? maxOfflineStorageBytes;

  /// Tỷ lệ cảnh báo dung lượng đĩa thấp (ví dụ: 0.10 tức là còn dưới 10% bộ nhớ).
  final double lowDiskWarningFraction;

  const StoragePolicyConfig({
    this.minFreeDiskHeadroomBytes = 524288000,
    this.maxOfflineStorageBytes,
    this.lowDiskWarningFraction = 0.10,
  });

  StoragePolicyConfig copyWith({
    int? minFreeDiskHeadroomBytes,
    int? maxOfflineStorageBytes,
    double? lowDiskWarningFraction,
  }) {
    return StoragePolicyConfig(
      minFreeDiskHeadroomBytes: minFreeDiskHeadroomBytes ?? this.minFreeDiskHeadroomBytes,
      maxOfflineStorageBytes: maxOfflineStorageBytes ?? this.maxOfflineStorageBytes,
      lowDiskWarningFraction: lowDiskWarningFraction ?? this.lowDiskWarningFraction,
    );
  }
}
