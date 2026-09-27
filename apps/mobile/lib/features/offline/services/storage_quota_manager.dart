import 'dart:math';

import '../../../core/storage/offline_storage_paths.dart';
import '../models/offline_chapter.dart';
import '../models/storage_policy_config.dart';
import '../repositories/offline_storage_repository.dart';
import 'disk_space_provider.dart';
import 'offline_deletion_service.dart';
import 'reader_lease_manager.dart';

/// Ngoại lệ ném ra khi không thể giải phóng đủ dung lượng cần thiết để đáp ứng yêu cầu.
class InsufficientStorageException implements Exception {
  final int requiredBytes;
  final int freedBytes;

  const InsufficientStorageException({
    required this.requiredBytes,
    required this.freedBytes,
  });

  @override
  String toString() =>
      'InsufficientStorageException: Cần giải phóng $requiredBytes bytes nhưng chỉ dọn dẹp được $freedBytes bytes (đã hết ứng viên có thể xóa).';
}

/// Kết quả của một phiên dọn dẹp bộ nhớ đệm (Eviction Result).
class EvictionResult {
  final List<OfflineChapter> evictedChapters;
  final int evictedBytes;
  final int requiredBytes;

  const EvictionResult({
    required this.evictedChapters,
    required this.evictedBytes,
    required this.requiredBytes,
  });

  const EvictionResult.empty()
      : evictedChapters = const [],
        evictedBytes = 0,
        requiredBytes = 0;
}

/// Quản lý hạn mức lưu trữ và bộ máy dọn dẹp LRU tất định (Deterministic LRU Eviction Engine).
///
/// Các quy tắc an toàn bất biến:
/// 1. Candidate Selection tất định: Chưa đọc trước, đọc xa hơn trước, cài trước, tie-breaker chapterVersionId ASC.
/// 2. Đa tầng loại trừ (Exclusions): pinned, active reader lease, active deleting reservation, checkpoint/excluded sets.
/// 3. Không bao giờ tự ý purge file trực tiếp: Mọi eviction BẮT BUỘC ủy quyền qua [OfflineDeletionService]
///    để tuân thủ Giao thức Xóa 3 Bước và Deletion Tombstones.
class StorageQuotaManager {
  final OfflineStorageRepository _repository;
  final OfflineStoragePaths _storagePaths;
  final OfflineDeletionService _deletionService;
  final ReaderLeaseManager _readerLeaseManager;
  final DiskSpaceProvider _diskSpaceProvider;
  final StoragePolicyConfig _config;

  StorageQuotaManager({
    required OfflineStorageRepository repository,
    required OfflineStoragePaths storagePaths,
    required OfflineDeletionService deletionService,
    required ReaderLeaseManager readerLeaseManager,
    required DiskSpaceProvider diskSpaceProvider,
    StoragePolicyConfig config = const StoragePolicyConfig(),
  })  : _repository = repository,
        _storagePaths = storagePaths,
        _deletionService = deletionService,
        _readerLeaseManager = readerLeaseManager,
        _diskSpaceProvider = diskSpaceProvider,
        _config = config {
    if (repository.userId != storagePaths.userId || repository.userId != deletionService.userId) {
      throw ArgumentError(
        'Identity mismatch in StorageQuotaManager: repo (${repository.userId}), paths (${storagePaths.userId}), deletion (${deletionService.userId})',
      );
    }
  }

  String get userId => _repository.userId;
  StoragePolicyConfig get config => _config;

  /// Lấy danh sách ứng viên có thể evict, được sắp xếp tất định và lọc sạch các ràng buộc loại trừ.
  Future<List<OfflineChapter>> getCandidates({Set<String>? excludedVersionIds}) async {
    final rawCandidates = await _repository.getEvictionCandidates();

    return rawCandidates.where((chapter) {
      final vId = chapter.chapterVersionId;

      // 1. Loại trừ nếu nằm trong danh sách loại trừ do caller chỉ định (active checkpoint/download)
      if (excludedVersionIds != null && excludedVersionIds.contains(vId)) {
        return false;
      }

      // 2. Loại trừ nếu đang có active reader lease
      if (_readerLeaseManager.isLeased(userId, vId)) {
        return false;
      }

      // 3. Loại trừ nếu đang có active deletion reservation
      if (_readerLeaseManager.isDeleting(userId, vId)) {
        return false;
      }

      return true;
    }).toList();
  }

  /// Dọn dẹp bộ nhớ để đủ dung lượng cho một gói tải mới có kích thước [incomingBytes].
  ///
  /// Kiểm tra 2 điều kiện:
  /// - Dung lượng đĩa trống của thiết bị sau khi tải phải >= [StoragePolicyConfig.minFreeDiskHeadroomBytes].
  /// - Tổng dung lượng offline sau khi tải không được vượt quá [StoragePolicyConfig.maxOfflineStorageBytes] (nếu có).
  ///
  /// Ném [InsufficientStorageException] nếu đã dọn dẹp hết candidates mà vẫn không đủ chỗ.
  Future<EvictionResult> evictToFit({
    required int incomingBytes,
    Set<String>? excludedVersionIds,
  }) async {
    final rootPath = await _storagePaths.getRootOfflinePath();
    final freeBytes = await _diskSpaceProvider.getFreeBytes(rootPath);
    final currentUsed = await _repository.getTotalStorageBytes();

    // 1. Tính toán số byte thiếu cho Headroom
    int headroomNeeded = 0;
    final projectedFree = freeBytes - incomingBytes;
    if (projectedFree < _config.minFreeDiskHeadroomBytes) {
      headroomNeeded = _config.minFreeDiskHeadroomBytes - projectedFree;
    }

    // 2. Tính toán số byte vượt Quota
    int quotaNeeded = 0;
    if (_config.maxOfflineStorageBytes != null) {
      final projectedUsed = currentUsed + incomingBytes;
      if (projectedUsed > _config.maxOfflineStorageBytes!) {
        quotaNeeded = projectedUsed - _config.maxOfflineStorageBytes!;
      }
    }

    final bytesToEvict = max(headroomNeeded, quotaNeeded);
    if (bytesToEvict <= 0) {
      return const EvictionResult.empty();
    }

    // 3. Thực hiện Eviction theo thứ tự tất định
    final candidates = await getCandidates(excludedVersionIds: excludedVersionIds);
    final evictedChapters = <OfflineChapter>[];
    int freedBytes = 0;

    for (final candidate in candidates) {
      try {
        // Mọi eviction BẮT BUỘC gọi qua DeletionService, không tự purge file!
        await _deletionService.deleteChapter(candidate.chapterVersionId);
        evictedChapters.add(candidate);
        freedBytes += candidate.totalBytes;

        if (freedBytes >= bytesToEvict) {
          break;
        }
      } on ChapterInUseException {
        // Vừa xuất hiện lease race condition trong lúc lặp, bỏ qua candidate
        continue;
      } on ChapterDeletingException {
        // Đang bị deleting bởi tiến trình khác, bỏ qua candidate
        continue;
      }
    }

    if (freedBytes < bytesToEvict) {
      throw InsufficientStorageException(
        requiredBytes: bytesToEvict,
        freedBytes: freedBytes,
      );
    }

    return EvictionResult(
      evictedChapters: evictedChapters,
      evictedBytes: freedBytes,
      requiredBytes: bytesToEvict,
    );
  }

  /// Dọn dẹp định kỳ đưa tổng dung lượng offline về dưới mức [StoragePolicyConfig.maxOfflineStorageBytes].
  Future<EvictionResult> evictToQuota({Set<String>? excludedVersionIds}) async {
    if (_config.maxOfflineStorageBytes == null) {
      return const EvictionResult.empty();
    }

    final currentUsed = await _repository.getTotalStorageBytes();
    if (currentUsed <= _config.maxOfflineStorageBytes!) {
      return const EvictionResult.empty();
    }

    final bytesToEvict = currentUsed - _config.maxOfflineStorageBytes!;
    final candidates = await getCandidates(excludedVersionIds: excludedVersionIds);
    final evictedChapters = <OfflineChapter>[];
    int freedBytes = 0;

    for (final candidate in candidates) {
      try {
        await _deletionService.deleteChapter(candidate.chapterVersionId);
        evictedChapters.add(candidate);
        freedBytes += candidate.totalBytes;

        if (freedBytes >= bytesToEvict) {
          break;
        }
      } on ChapterInUseException {
        continue;
      } on ChapterDeletingException {
        continue;
      }
    }

    return EvictionResult(
      evictedChapters: evictedChapters,
      evictedBytes: freedBytes,
      requiredBytes: bytesToEvict,
    );
  }
}
