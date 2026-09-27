import 'dart:async';
import '../../../core/storage/offline_storage_paths.dart';
import '../models/storage_policy_config.dart';
import 'disk_space_provider.dart';
import 'storage_quota_manager.dart';

/// Ngoại lệ ném ra khi DiskSpaceProvider gặp sự cố, trả về dung lượng đĩa âm hoặc không đọc được.
class DiskSpaceUnavailableException implements Exception {
  final String message;
  const DiskSpaceUnavailableException(this.message);

  @override
  String toString() => 'DiskSpaceUnavailableException: $message';
}

/// Ngoại lệ ném ra khi một tác vụ tải bị từ chối tiếp nhận (Admission Denied) do không đủ dung lượng.
class StorageAdmissionDeniedException implements Exception {
  final String message;
  final int requiredBytes;
  final int? availableBytes;

  const StorageAdmissionDeniedException(
    this.message, {
    this.requiredBytes = 0,
    this.availableBytes,
  });

  @override
  String toString() =>
      'StorageAdmissionDeniedException: $message (Yêu cầu: $requiredBytes bytes, Khả dụng: $availableBytes bytes)';
}

/// Token đại diện cho một hạn mức dung lượng đã được giữ chỗ trong RAM (Admission Reservation).
class AdmissionReservationToken {
  final String taskId;
  final String chapterVersionId;
  final int reservedBytes;

  const AdmissionReservationToken({
    required this.taskId,
    required this.chapterVersionId,
    required this.reservedBytes,
  });
}

/// Điều phối viên Tiếp nhận Lưu trữ (Storage Admission Coordinator).
///
/// **Các Bất Biến Cốt Lõi (Invariants):**
/// 1. **Zero Downloaded Bytes Trước Admission:** Mọi tác vụ tải về BẮT BUỘC phải vượt qua
///    Gate 6 Admission trước khi mở HTTP stream và ghi bất kỳ byte nào vào đĩa.
/// 2. **Chống Concurrent Overcommit (RAM Reservation Ledger):** Duy trì sổ cái các tác vụ
///    đang tải song song trong RAM. Mọi quyết định tiếp nhận đều tính đến tổng số byte đã
///    được giữ chỗ trước đó (`_activeDownloadReservations`).
/// 3. **Fail-Closed khi Hệ thống Đĩa Gặp Sự Cố:** Nếu [DiskSpaceProvider] ném ngoại lệ hoặc
///    trả về số byte <= 0, lập tức từ chối tiếp nhận với [DiskSpaceUnavailableException].
/// 4. **Eviction-Assisted Admission:** Tự động kích hoạt dọn dẹp LRU qua [StorageQuotaManager]
///    khi dung lượng khả dụng chưa đủ, đồng thời bảo vệ các phiên bản đang được giữ chỗ.
class StorageAdmissionCoordinator {
  final DiskSpaceProvider _diskSpaceProvider;
  final StorageQuotaManager _storageQuotaManager;
  final OfflineStoragePaths _storagePaths;
  final StoragePolicyConfig _config;

  // Sổ cái giữ chỗ dung lượng trong RAM (taskId -> reservedBytes)
  final Map<String, int> _activeDownloadReservations = {};
  final Map<String, String> _taskVersionMap = {};

  // Khóa tuần tự hóa admission trong isolate để loại trừ race condition overcommit
  Completer<void>? _admissionMutex;

  StorageAdmissionCoordinator({
    required DiskSpaceProvider diskSpaceProvider,
    required StorageQuotaManager storageQuotaManager,
    required OfflineStoragePaths storagePaths,
    StoragePolicyConfig config = const StoragePolicyConfig(),
  })  : _diskSpaceProvider = diskSpaceProvider,
        _storageQuotaManager = storageQuotaManager,
        _storagePaths = storagePaths,
        _config = config {
    if (storageQuotaManager.userId != storagePaths.userId) {
      throw ArgumentError(
        'Identity mismatch in StorageAdmissionCoordinator: quotaManager (${storageQuotaManager.userId}) != storagePaths (${storagePaths.userId})',
      );
    }
  }

  String get userId => _storagePaths.userId;
  int get totalReservedDownloadBytes =>
      _activeDownloadReservations.values.fold(0, (a, b) => a + b);

  Set<String> get activeReservedVersionIds => Set<String>.unmodifiable(_taskVersionMap.values);

  bool hasReservation(String taskId) => _activeDownloadReservations.containsKey(taskId);

  /// Kiểm tra và tiếp nhận tác vụ tải về một cách nguyên tử trong RAM (Gate 6 Admission).
  ///
  /// Ném [DiskSpaceUnavailableException] nếu không đọc được dung lượng đĩa.
  /// Ném [StorageAdmissionDeniedException] nếu không thể giải phóng đủ dung lượng (fail-closed).
  Future<AdmissionReservationToken> admitDownload({
    required String taskId,
    required String chapterVersionId,
    required int requiredBytes,
  }) async {
    // 0. Tuần tự hóa admission qua Mutex trong isolate
    while (_admissionMutex != null) {
      await _admissionMutex!.future;
    }
    final completer = Completer<void>();
    _admissionMutex = completer;

    try {
      // 1. Tính Idempotency: Nếu task này đã giữ chỗ trước đó, cập nhật hoặc trả về token hiện tại
      if (_activeDownloadReservations.containsKey(taskId)) {
        final existingBytes = _activeDownloadReservations[taskId]!;
        if (existingBytes == requiredBytes) {
          return AdmissionReservationToken(
            taskId: taskId,
            chapterVersionId: chapterVersionId,
            reservedBytes: requiredBytes,
          );
        }
      }

      // 2. Đọc dung lượng đĩa trống hiện tại (Fail-closed)
      final rootPath = await _storagePaths.getRootOfflinePath();
      final int rawFreeBytes;
      try {
        rawFreeBytes = await _diskSpaceProvider.getFreeBytes(rootPath);
      } catch (e) {
        throw DiskSpaceUnavailableException('Lỗi khi truy vấn dung lượng đĩa trống: $e');
      }

      if (rawFreeBytes <= 0) {
        throw DiskSpaceUnavailableException(
          'Dung lượng đĩa trống không hợp lệ hoặc thiết bị đã hết bộ nhớ: $rawFreeBytes bytes',
        );
      }

      // 3. Tính toán dung lượng khả dụng thực tế sau khi trừ đi các task đang tải song song
      final otherReservations = totalReservedDownloadBytes - (_activeDownloadReservations[taskId] ?? 0);
      final effectiveFree = rawFreeBytes - otherReservations;

      // 4. Kiểm tra OS Headroom
      final projectedFree = effectiveFree - requiredBytes;
      int shortfall = 0;
      if (projectedFree < _config.minFreeDiskHeadroomBytes) {
        shortfall = _config.minFreeDiskHeadroomBytes - projectedFree;
      }

      // 5. Nếu thiếu dung lượng -> Eviction-assisted admission
      if (shortfall > 0) {
        // Loại trừ chapterVersionId hiện tại và tất cả các phiên bản đang được tải song song
        final excluded = <String>{chapterVersionId, ..._taskVersionMap.values};

        try {
          await _storageQuotaManager.evictToFit(
            incomingBytes: requiredBytes + otherReservations,
            excludedVersionIds: excluded,
          );
        } on InsufficientStorageException catch (e) {
          throw StorageAdmissionDeniedException(
            'Không đủ dung lượng đĩa khả dụng để tải về và không thể giải phóng thêm từ LRU cache.',
            requiredBytes: requiredBytes,
            availableBytes: effectiveFree,
          );
        }

        // Re-read dung lượng đĩa sau eviction
        final postEvictFree = await _diskSpaceProvider.getFreeBytes(rootPath);
        final postEffective = postEvictFree - otherReservations;
        if (postEffective - requiredBytes < _config.minFreeDiskHeadroomBytes) {
          throw StorageAdmissionDeniedException(
            'Dung lượng đĩa sau khi dọn dẹp vẫn không đạt mức headroom tối thiểu.',
            requiredBytes: requiredBytes,
            availableBytes: postEffective,
          );
        }
      }

      // 6. Ghi nhận reservation vào sổ cái RAM
      _activeDownloadReservations[taskId] = requiredBytes;
      _taskVersionMap[taskId] = chapterVersionId;

      return AdmissionReservationToken(
        taskId: taskId,
        chapterVersionId: chapterVersionId,
        reservedBytes: requiredBytes,
      );
    } finally {
      completer.complete();
      if (identical(_admissionMutex, completer)) {
        _admissionMutex = null;
      }
    }
  }

  /// Giải phóng chỗ đã giữ trong RAM khi task hoàn tất, bị tạm dừng, hủy bỏ hoặc thất bại.
  void releaseReservation(String taskId) {
    _activeDownloadReservations.remove(taskId);
    _taskVersionMap.remove(taskId);
  }

  /// Xóa toàn bộ reservation trong RAM (phục vụ reset hoặc shutdown).
  void clearAllReservations() {
    _activeDownloadReservations.clear;
    _taskVersionMap.clear();
  }
}
