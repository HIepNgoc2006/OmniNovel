import 'dart:async';
import '../../../core/storage/offline_storage_paths.dart';
import '../models/storage_policy_config.dart';
import 'disk_space_provider.dart';
import 'storage_quota_manager.dart';

export 'disk_space_provider.dart' show DiskSpaceUnavailableException;

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

/// Token đại diện cho một hạn mức dung lượng tải về đã được giữ chỗ trong RAM (Gate 6 Admission Token).
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

/// Token đại diện cho một hạn mức dung lượng giải nén & cài đặt trong RAM (Gate 7 Installation Token).
class InstallationReservationToken {
  final String taskId;
  final String chapterVersionId;
  final int reservedExtractionBytes;
  final int reservedInstallQuotaBytes;

  const InstallationReservationToken({
    required this.taskId,
    required this.chapterVersionId,
    required this.reservedExtractionBytes,
    required this.reservedInstallQuotaBytes,
  });
}

/// Điều phối viên Tiếp nhận Lưu trữ (Storage Admission Coordinator).
///
/// **Các Bất Biến Kiến Trúc Cốt Lõi (Invariants):**
/// 1. **Zero Downloaded Bytes Trước Gate 6 Admission:** Mọi tác vụ tải về BẮT BUỘC phải vượt qua
///    Gate 6 Admission trước khi mở HTTP stream và ghi bất kỳ byte nào vào đĩa.
/// 2. **Multi-Ledger Concurrency Isolation:** Duy trì 3 sổ cái độc lập trong RAM:
///    - `downloadReservations`: Số byte tải nén còn lại chưa ghi xuống tệp `.part` (Remaining-unmaterialized).
///    - `extractionReservations`: Số byte giải nén staging chưa materialize xuống thư mục staging.
///    - `installQuotaReservations`: Dự phóng dung lượng cài đặt uncompressed chưa commit vào SQLite.
/// 3. **Remaining-Unmaterialized Accounting (Tránh Double-Counting):** Khi các byte được ghi thật
///    xuống `.part` hoặc giải nén xong vào staging, dung lượng đĩa trống thực tế của OS đã giảm.
///    Ledger được cập nhật giảm tương ứng theo byte thực tế chưa ghi, không giữ nguyên toàn bộ kích thước.
/// 4. **Dual-Budgeting Decoupling (Headroom vs App Quota):**
///    - Gate 6: Chỉ dọn dẹp để bảo toàn Physical Disk Headroom (`minFreeDiskHeadroomBytes`).
///      Tuyệt đối KHÔNG ép App Installed Quota bằng tệp nén tải về.
///    - Gate 7: Enforce độc lập cả Physical Disk Headroom (cho staging expansion) và App Installed Quota
///      (bằng projected uncompressed bytes).
/// 5. **Fail-Closed khi Hệ thống Đĩa Gặp Sự Cố:** Nếu [DiskSpaceProvider] ném ngoại lệ hoặc
///    trả về số byte <= 0, lập tức từ chối tiếp nhận với [DiskSpaceUnavailableException].
/// 6. **Re-Read Ground Truth sau Eviction:** Không giả định số byte của ứng viên bị xóa là chính xác,
///    bắt buộc đọc lại đĩa và CSDL sau khi dọn dẹp rồi mới reserve nguyên tử.
class StorageAdmissionCoordinator {
  final DiskSpaceProvider _diskSpaceProvider;
  final StorageQuotaManager _storageQuotaManager;
  final OfflineStoragePaths _storagePaths;
  final StoragePolicyConfig _config;

  // 1. Download Ledger: taskId -> remainingReservedDownloadBytes (chưa ghi xuống .part)
  final Map<String, int> _activeDownloadReservations = {};
  final Map<String, String> _downloadTaskVersionMap = {};

  // 2. Extraction Ledger: taskId -> remainingReservedExtractionBytes (chưa materialize vào staging)
  final Map<String, int> _activeExtractionReservations = {};
  final Map<String, String> _extractionTaskVersionMap = {};

  // 3. Install Quota Ledger: taskId -> reservedInstallQuotaBytes (chưa commit SQLite)
  final Map<String, int> _activeInstallQuotaReservations = {};
  final Map<String, String> _installQuotaTaskVersionMap = {};

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

  int get totalReservedExtractionBytes =>
      _activeExtractionReservations.values.fold(0, (a, b) => a + b);

  int get totalReservedInstallQuotaBytes =>
      _activeInstallQuotaReservations.values.fold(0, (a, b) => a + b);

  /// Tổng số byte đang được giữ chỗ trên đĩa vật lý (chưa ghi thật xuống đĩa).
  int get totalReservedDiskBytes =>
      totalReservedDownloadBytes + totalReservedExtractionBytes;

  /// Tập hợp tất cả chapterVersionId đang có reservation hoạt động (bảo vệ khỏi LRU eviction).
  Set<String> get activeReservedVersionIds => Set<String>.unmodifiable({
        ..._downloadTaskVersionMap.values,
        ..._extractionTaskVersionMap.values,
        ..._installQuotaTaskVersionMap.values,
      });

  bool hasReservation(String taskId) =>
      (_activeDownloadReservations[taskId] ?? 0) > 0 ||
      (_activeExtractionReservations[taskId] ?? 0) > 0 ||
      (_activeInstallQuotaReservations[taskId] ?? 0) > 0;

  // =========================================================================
  // GATE 6: PRE-DOWNLOAD ADMISSION
  // =========================================================================

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
      // 1. Idempotency: Nếu task này đã giữ chỗ trước đó, cập nhật hoặc trả về token hiện tại
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

      // 3. Tính toán dung lượng khả dụng sau khi trừ các reservation đĩa khác
      final otherReservations =
          totalReservedDiskBytes - (_activeDownloadReservations[taskId] ?? 0);
      final effectiveFree = rawFreeBytes - otherReservations;

      // 4. Kiểm tra OS Headroom (Gate 6 chỉ kiểm tra Physical Headroom, KHÔNG ép Installed Quota)
      final projectedFree = effectiveFree - requiredBytes;
      int shortfall = 0;
      if (projectedFree < _config.minFreeDiskHeadroomBytes) {
        shortfall = _config.minFreeDiskHeadroomBytes - projectedFree;
      }

      // 5. Nếu thiếu dung lượng -> Dọn dẹp LRU phục vụ Physical Headroom
      if (shortfall > 0) {
        final excluded = <String>{chapterVersionId, ...activeReservedVersionIds};

        try {
          await _storageQuotaManager.evictForDiskHeadroom(
            incomingBytes: requiredBytes + otherReservations,
            excludedVersionIds: excluded,
          );
        } on InsufficientStorageException {
          throw StorageAdmissionDeniedException(
            'Không đủ dung lượng đĩa khả dụng để tải về và không thể giải phóng thêm từ LRU cache.',
            requiredBytes: requiredBytes,
            availableBytes: effectiveFree,
          );
        }

        // Re-read dung lượng đĩa sau eviction (Ground truth verification)
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

      // 6. Ghi nhận reservation vào sổ cái RAM (Remaining = requiredBytes ban đầu)
      _activeDownloadReservations[taskId] = requiredBytes;
      _downloadTaskVersionMap[taskId] = chapterVersionId;

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

  /// Cập nhật số byte reservation tải về còn lại chưa ghi xuống đĩa (Remaining-unmaterialized).
  /// Giúp tránh double-counting khi tệp `.part` đã lớn lên trên filesystem làm giảm raw free disk.
  void updateRemainingDownloadReservation(String taskId, int remainingBytes) {
    if (_activeDownloadReservations.containsKey(taskId)) {
      final current = _activeDownloadReservations[taskId]!;
      _activeDownloadReservations[taskId] = remainingBytes.clamp(0, current);
    }
  }

  /// Tiêu thụ bớt một lượng byte đã ghi thành công xuống tệp `.part`.
  void consumeDownloadReservation(String taskId, int writtenBytesDelta) {
    if (_activeDownloadReservations.containsKey(taskId) && writtenBytesDelta > 0) {
      final current = _activeDownloadReservations[taskId]!;
      _activeDownloadReservations[taskId] = (current - writtenBytesDelta).clamp(0, current);
    }
  }

  /// Giải phóng chỗ đã giữ của luồng tải về trong RAM.
  void releaseDownloadReservation(String taskId) {
    _activeDownloadReservations.remove(taskId);
    _downloadTaskVersionMap.remove(taskId);
  }

  // =========================================================================
  // GATE 7: PRE-EXTRACTION & INSTALLATION ADMISSION
  // =========================================================================

  /// Kiểm tra và tiếp nhận tác vụ giải nén & cài đặt gói offline một cách nguyên tử (Gate 7 Admission).
  ///
  /// Thực hiện kiểm tra 2 budget độc lập:
  /// 1. **Physical Disk Headroom:** Đảm bảo sau khi giải nén vào staging, dung lượng đĩa trống
  ///    (sau khi trừ các download & extraction reservations khác) vẫn >= [minFreeDiskHeadroomBytes].
  /// 2. **Installed App Quota:** Đảm bảo sau khi cài đặt uncompressed bytes, tổng dung lượng offline
  ///    (sau khi cộng các install quota reservations khác) không vượt quá [maxOfflineStorageBytes].
  ///
  /// Ném [DiskSpaceUnavailableException] nếu không đọc được dung lượng đĩa.
  /// Ném [StorageAdmissionDeniedException] nếu không thể giải phóng đủ dung lượng (fail-closed).
  Future<InstallationReservationToken> admitInstallation({
    required String taskId,
    required String chapterVersionId,
    required int uncompressedExpansionBytes,
  }) async {
    while (_admissionMutex != null) {
      await _admissionMutex!.future;
    }
    final completer = Completer<void>();
    _admissionMutex = completer;

    try {
      final rootPath = await _storagePaths.getRootOfflinePath();

      // -----------------------------------------------------------------------
      // 1. Physical Disk Headroom Check & Eviction
      // -----------------------------------------------------------------------
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

      // Trừ các reservation đĩa khác ngoài chính task này
      final otherReservedDisk =
          totalReservedDiskBytes - (_activeExtractionReservations[taskId] ?? 0);
      final effectiveFree = rawFreeBytes - otherReservedDisk;
      final projectedFree = effectiveFree - uncompressedExpansionBytes;

      if (projectedFree < _config.minFreeDiskHeadroomBytes) {
        final excluded = <String>{chapterVersionId, ...activeReservedVersionIds};

        try {
          await _storageQuotaManager.evictForDiskHeadroom(
            incomingBytes: uncompressedExpansionBytes + otherReservedDisk,
            excludedVersionIds: excluded,
          );
        } on InsufficientStorageException {
          throw StorageAdmissionDeniedException(
            'Không đủ dung lượng đĩa khả dụng để giải nén gói offline và không thể giải phóng thêm từ LRU cache.',
            requiredBytes: uncompressedExpansionBytes,
            availableBytes: effectiveFree,
          );
        }

        // Re-read dung lượng đĩa thực tế sau eviction (Ground truth verification)
        final postEvictFree = await _diskSpaceProvider.getFreeBytes(rootPath);
        final postEffective = postEvictFree - otherReservedDisk;
        if (postEffective - uncompressedExpansionBytes < _config.minFreeDiskHeadroomBytes) {
          throw StorageAdmissionDeniedException(
            'Dung lượng đĩa sau khi dọn dẹp vẫn không đạt mức headroom tối thiểu để giải nén.',
            requiredBytes: uncompressedExpansionBytes,
            availableBytes: postEffective,
          );
        }
      }

      // -----------------------------------------------------------------------
      // 2. Installed App Quota Check & Eviction
      // -----------------------------------------------------------------------
      if (_config.maxOfflineStorageBytes != null) {
        final currentInstalled = await _storageQuotaManager.getTotalInstalledBytes();
        final otherReservedQuota =
            totalReservedInstallQuotaBytes - (_activeInstallQuotaReservations[taskId] ?? 0);
        final projectedInstalled =
            currentInstalled + otherReservedQuota + uncompressedExpansionBytes;

        if (projectedInstalled > _config.maxOfflineStorageBytes!) {
          final excluded = <String>{chapterVersionId, ...activeReservedVersionIds};

          try {
            await _storageQuotaManager.evictForInstalledQuota(
              incomingInstalledBytes: uncompressedExpansionBytes + otherReservedQuota,
              excludedVersionIds: excluded,
            );
          } on InsufficientStorageException {
            throw StorageAdmissionDeniedException(
              'Dung lượng cài đặt vượt quá hạn mức tối đa cho phép (${_config.maxOfflineStorageBytes} bytes) và không thể giải phóng thêm từ LRU cache.',
              requiredBytes: uncompressedExpansionBytes,
              availableBytes: _config.maxOfflineStorageBytes! - (currentInstalled + otherReservedQuota),
            );
          }

          // Re-read ground truth cả DB usage và đĩa sau khi eviction
          final postInstalled = await _storageQuotaManager.getTotalInstalledBytes();
          if (postInstalled + otherReservedQuota + uncompressedExpansionBytes >
              _config.maxOfflineStorageBytes!) {
            throw StorageAdmissionDeniedException(
              'Dung lượng cài đặt sau khi dọn dẹp vẫn vượt quá hạn mức tối đa cho phép.',
              requiredBytes: uncompressedExpansionBytes,
              availableBytes: _config.maxOfflineStorageBytes! - (postInstalled + otherReservedQuota),
            );
          }
        }
      }

      // -----------------------------------------------------------------------
      // 3. Ghi nhận vào RAM Ledgers
      // -----------------------------------------------------------------------
      _activeExtractionReservations[taskId] = uncompressedExpansionBytes;
      _extractionTaskVersionMap[taskId] = chapterVersionId;

      _activeInstallQuotaReservations[taskId] = uncompressedExpansionBytes;
      _installQuotaTaskVersionMap[taskId] = chapterVersionId;

      return InstallationReservationToken(
        taskId: taskId,
        chapterVersionId: chapterVersionId,
        reservedExtractionBytes: uncompressedExpansionBytes,
        reservedInstallQuotaBytes: uncompressedExpansionBytes,
      );
    } finally {
      completer.complete();
      if (identical(_admissionMutex, completer)) {
        _admissionMutex = null;
      }
    }
  }

  /// Cập nhật số byte reservation giải nén còn lại chưa materialize vào staging.
  void updateRemainingExtractionReservation(String taskId, int remainingBytes) {
    if (_activeExtractionReservations.containsKey(taskId)) {
      final current = _activeExtractionReservations[taskId]!;
      _activeExtractionReservations[taskId] = remainingBytes.clamp(0, current);
    }
  }

  /// Tiêu thụ bớt reservation giải nén khi các tệp con được ghi vào staging.
  void consumeExtractionReservation(String taskId, int writtenBytesDelta) {
    if (_activeExtractionReservations.containsKey(taskId) && writtenBytesDelta > 0) {
      final current = _activeExtractionReservations[taskId]!;
      _activeExtractionReservations[taskId] = (current - writtenBytesDelta).clamp(0, current);
    }
  }

  /// Giải phóng chỗ đã giữ của luồng giải nén staging trong RAM.
  void releaseExtractionReservation(String taskId) {
    _activeExtractionReservations.remove(taskId);
    _extractionTaskVersionMap.remove(taskId);
  }

  /// Giải phóng chỗ đã giữ của hạn mức cài đặt trong RAM (gọi sau khi SQLite commit thành công).
  void releaseInstallQuotaReservation(String taskId) {
    _activeInstallQuotaReservations.remove(taskId);
    _installQuotaTaskVersionMap.remove(taskId);
  }

  /// Giải phóng toàn bộ chỗ đã giữ (download, extraction, install quota) cho một task.
  void releaseReservation(String taskId) {
    releaseDownloadReservation(taskId);
    releaseExtractionReservation(taskId);
    releaseInstallQuotaReservation(taskId);
  }

  /// Xóa toàn bộ reservation trong RAM (phục vụ reset hoặc shutdown).
  void clearAllReservations() {
    _activeDownloadReservations.clear();
    _downloadTaskVersionMap.clear();
    _activeExtractionReservations.clear();
    _extractionTaskVersionMap.clear();
    _activeInstallQuotaReservations.clear();
    _installQuotaTaskVersionMap.clear();
  }
}
