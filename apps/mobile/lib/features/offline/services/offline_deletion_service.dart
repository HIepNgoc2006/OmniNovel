import '../../../core/storage/offline_storage_paths.dart';
import '../repositories/offline_storage_repository.dart';
import 'reader_lease_manager.dart';

/// Dịch vụ xóa ngoại tuyến tất định (Deterministic Deletion Service).
/// Thực thi Giao thức Xóa 3 Bước (3-Step Deletion Protocol):
///   Bước 1: DB Atomic Revocation (Tombstone + Xóa khỏi inventory offline_chapters)
///   Bước 2: Filesystem Purge (Xóa sạch thư mục installed, tmp, staging)
///   Bước 3: DB Finalize (Xóa Tombstone và DownloadTask)
///
/// Tích hợp Lease Protection: từ chối xóa khi chapter đang được reader đọc active (fail-closed).
class OfflineDeletionService {
  final OfflineStorageRepository _repository;
  final OfflineStoragePaths _storagePaths;
  final ReaderLeaseManager _readerLeaseManager;

  OfflineDeletionService({
    required OfflineStorageRepository repository,
    required OfflineStoragePaths storagePaths,
    required ReaderLeaseManager readerLeaseManager,
  })  : _repository = repository,
        _storagePaths = storagePaths,
        _readerLeaseManager = readerLeaseManager {
    if (repository.userId != storagePaths.userId) {
      throw ArgumentError(
        'Identity mismatch in OfflineDeletionService: repository (${repository.userId}) != storagePaths (${storagePaths.userId})',
      );
    }
  }

  String get userId => _repository.userId;

  /// Xóa một chương truyện ngoại tuyến theo [chapterVersionId].
  /// Ném [ChapterInUseException] nếu chương đang có active reader lease.
  /// Ném [ChapterDeletingException] nếu chương đang được giữ bởi một tiến trình xóa khác.
  Future<void> deleteChapter(String chapterVersionId) async {
    // 0. Deletion Reservation Guard (Process-Local Atomicity & Race Prevention)
    final reservation = _readerLeaseManager.reserveDeletion(
      userId: userId,
      chapterVersionId: chapterVersionId,
    );

    try {
      final micros = DateTime.now().microsecondsSinceEpoch;
      final tombstoneId = 'tomb_${_storagePaths.userScope}_${chapterVersionId}_$micros';

      // Bước 1: DB Atomic Revocation
      await _repository.atomicRevokeChapter(
        chapterVersionId,
        tombstoneId: tombstoneId,
      );

      // Bước 2: Filesystem Purge
      await _purgePayloadFiles(chapterVersionId);

      // Bước 3: DB Finalize
      await _repository.atomicFinalizeChapterDeletion(chapterVersionId);
    } finally {
      _readerLeaseManager.releaseDeletionReservation(reservation);
    }
  }

  /// Xóa toàn bộ các chương ngoại tuyến của một bộ truyện theo [storyId] (Batch Story Deletion).
  /// Tuân thủ nguyên tắc All-or-Nothing: Nếu có BẤT KỲ chương nào trong truyện đang có active lease
  /// hoặc đang deleting, lập tức từ chối và ném ngoại lệ mà không xóa bất kỳ chương nào trong batch.
  Future<void> deleteStory(String storyId) async {
    final chapters = await _repository.getOfflineChaptersByStory(storyId);
    if (chapters.isEmpty) return;

    final versionIds = chapters.map((c) => c.chapterVersionId).toList(growable: false);

    // 0. Batch Deletion Reservation Guard (Process-Local All-or-Nothing)
    final reservations = _readerLeaseManager.reserveDeletionBatch(
      userId: userId,
      chapterVersionIds: versionIds,
    );

    try {
      final nowMicros = DateTime.now().microsecondsSinceEpoch;

      // Bước 1: DB Atomic Revocation (Batch)
      await _repository.atomicRevokeChapters(
        versionIds,
        tombstoneIdGenerator: (verId) => 'tomb_${_storagePaths.userScope}_${verId}_$nowMicros',
      );

      // Bước 2: Filesystem Purge cho từng version
      for (final verId in versionIds) {
        await _purgePayloadFiles(verId);
      }

      // Bước 3: DB Finalize (Batch)
      await _repository.atomicFinalizeChaptersDeletion(versionIds);
    } finally {
      _readerLeaseManager.releaseDeletionReservationBatch(reservations);
    }
  }

  /// Dọn sạch các tệp trên đĩa cho một chapterVersionId (installed, tmp .part, staging)
  Future<void> _purgePayloadFiles(String chapterVersionId) async {
    await _storagePaths.deleteInstalledDir(chapterVersionId);
    await _storagePaths.deletePartFile(chapterVersionId);
    await _storagePaths.deleteStagingDir(chapterVersionId);
  }
}
