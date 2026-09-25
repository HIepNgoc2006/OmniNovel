import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import '../../../core/storage/offline_storage_paths.dart';
import '../models/download_task.dart';
import '../models/offline_chapter.dart';
import '../repositories/offline_storage_repository.dart';

// ==========================================
// EXCEPTIONS (FAIL-CLOSED ARCHITECTURE)
// ==========================================

/// Ngoại lệ cơ sở cho các lỗi cài đặt gói offline.
class OfflineInstallationException implements Exception {
  final String message;
  const OfflineInstallationException(this.message);

  @override
  String toString() => 'OfflineInstallationException: $message';
}

/// Gate 1: Mã băm SHA-256 không khớp với hash đã pin trên download_tasks.
class ChecksumMismatchException extends OfflineInstallationException {
  const ChecksumMismatchException(super.message);
}

/// Gate 2: Tệp manifest.json không hợp lệ, thiếu tệp con, hoặc sai lệch định danh.
class ManifestValidationException extends OfflineInstallationException {
  const ManifestValidationException(super.message);
}

/// Gate 3: Phát hiện tấn công Zip Slip (path traversal ra ngoài staging root).
class ZipSlipException extends OfflineInstallationException {
  const ZipSlipException(super.message);
}

/// Gate 3: Tệp nén chứa symlink/hardlink hoặc cấu trúc nguy hại/malformed.
class UnsafeArchiveException extends OfflineInstallationException {
  const UnsafeArchiveException(super.message);
}

/// Gate 4: Vượt ngưỡng an toàn giải nén (Zip Bomb mitigation).
class ZipBombException extends OfflineInstallationException {
  const ZipBombException(super.message);
}

// ==========================================
// DATA TRANSFER OBJECTS FOR ISOLATE
// ==========================================

/// Tham số truyền vào background isolate để giải nén an toàn.
class SafeExtractionRequest {
  final String zipFilePath;
  final String stagingDirPath;
  final int maxEntries;
  final int maxUncompressedSize;

  const SafeExtractionRequest({
    required this.zipFilePath,
    required this.stagingDirPath,
    this.maxEntries = 1000,
    this.maxUncompressedSize = 500 * 1024 * 1024, // 500 MB
  });
}

/// Kết quả trích xuất sau khi giải nén an toàn.
class SafeExtractionResult {
  final int totalEntries;
  final int totalBytes;

  const SafeExtractionResult({
    required this.totalEntries,
    required this.totalBytes,
  });
}

/// Báo cáo kết quả phục hồi hai chiều khi app khởi động lại.
class ReconciliationReport {
  final int cleanedStagingDirs;
  final int removedCorruptedRows;
  final int reconstructedRows;
  final int removedOrphanDirs;
  final int cleanedPartFiles;

  const ReconciliationReport({
    this.cleanedStagingDirs = 0,
    this.removedCorruptedRows = 0,
    this.reconstructedRows = 0,
    this.removedOrphanDirs = 0,
    this.cleanedPartFiles = 0,
  });

  @override
  String toString() =>
      'ReconciliationReport(stagingCleaned: $cleanedStagingDirs, corruptedRowsRemoved: $removedCorruptedRows, rowsReconstructed: $reconstructedRows, orphanDirsRemoved: $removedOrphanDirs, partFilesCleaned: $cleanedPartFiles)';
}

// ==========================================
// TOP-LEVEL ISOLATE WORKERS
// ==========================================

/// Tính mã băm SHA-256 của tệp trong background isolate.
Future<String> computeFileSha256Isolate(String filePath) async {
  final file = File(filePath);
  if (!file.existsSync()) {
    throw FileSystemException('Tệp không tồn tại để tính SHA-256', filePath);
  }
  final stream = file.openRead();
  final digest = await sha256.bind(stream).first;
  return digest.toString();
}

/// Giải nén tệp ZIP an toàn trong background isolate (fail-closed).
SafeExtractionResult safeExtractArchiveIsolate(SafeExtractionRequest request) {
  final zipFile = File(request.zipFilePath);
  if (!zipFile.existsSync()) {
    throw FileSystemException('Tệp ZIP không tồn tại', request.zipFilePath);
  }

  final bytes = zipFile.readAsBytesSync();
  Archive archive;
  try {
    archive = ZipDecoder().decodeBytes(bytes, verify: true);
  } catch (e) {
    throw UnsafeArchiveException('Tệp ZIP bị hỏng hoặc sai định dạng: $e');
  }

  final stagingDir = Directory(request.stagingDirPath);
  if (!stagingDir.existsSync()) {
    stagingDir.createSync(recursive: true);
  }
  final stagingCanonical = p.canonicalize(stagingDir.path);

  int totalEntries = 0;
  int totalBytes = 0;
  final Set<String> seenPaths = {};

  for (final entry in archive) {
    totalEntries++;
    if (totalEntries > request.maxEntries) {
      throw ZipBombException(
          'Vượt quá số lượng tệp tối đa cho phép trong tệp nén (${request.maxEntries})');
    }

    totalBytes += entry.size;
    if (totalBytes > request.maxUncompressedSize) {
      throw ZipBombException(
          'Tổng dung lượng giải nén vượt quá hạn mức an toàn (${request.maxUncompressedSize} bytes)');
    }

    // Gate 3: Chặn symlink / hardlink
    if (entry.isSymbolicLink) {
      throw const UnsafeArchiveException('Phát hiện symlink/hardlink không an toàn trong tệp nén');
    }

    // Gate 3: Chặn Zip Slip & Absolute path traversal
    final rawName = entry.name.replaceAll('\\', '/');
    if (rawName.startsWith('/') || rawName.contains(':')) {
      throw ZipSlipException('Đường dẫn tuyệt đối không an toàn: ${entry.name}');
    }

    final normalized = p.normalize(rawName);
    if (normalized == '..' || normalized.startsWith('../') || normalized.startsWith('..\\') || p.isAbsolute(normalized)) {
      throw ZipSlipException('Phát hiện tấn công Zip Slip (path traversal): ${entry.name}');
    }

    final destPath = p.normalize(p.join(stagingCanonical, normalized));
    final destCanonical = p.canonicalize(destPath);

    if (!destCanonical.startsWith(stagingCanonical + p.separator) && destCanonical != stagingCanonical) {
      throw ZipSlipException('Đường dẫn giải nén thoát khỏi thư mục staging: ${entry.name}');
    }

    // Chặn duplicate paths
    if (seenPaths.contains(destCanonical)) {
      throw UnsafeArchiveException('Phát hiện đường dẫn trùng lặp trong tệp nén: ${entry.name}');
    }
    seenPaths.add(destCanonical);

    if (entry.isFile) {
      final parentDir = Directory(p.dirname(destCanonical));
      if (!parentDir.existsSync()) {
        parentDir.createSync(recursive: true);
      }
      final outFile = File(destCanonical);
      outFile.writeAsBytesSync(entry.content as List<int>, flush: true);
    } else {
      final outDir = Directory(destCanonical);
      if (!outDir.existsSync()) {
        outDir.createSync(recursive: true);
      }
    }
  }

  return SafeExtractionResult(
    totalEntries: totalEntries,
    totalBytes: totalBytes,
  );
}

// ==========================================
// BUNDLE INSTALLER (PHASE 5D.4 SSoT)
// ==========================================

typedef ComputeRunner = Future<R> Function<Q, R>(
    FutureOr<R> Function(Q message) callback, Q message);

/// Dịch vụ cài đặt gói offline an toàn & phục hồi toàn vẹn hai chiều (Phase 5D.4).
///
/// TUÂN THỦ NGHIÊM NGẶT 10 BẤT BIẾN KIẾN TRÚC:
/// 1. Ownership tuyệt đối: Duy nhất BundleInstaller ghi READY | FAILED.
/// 2. Checksum-before-unzip: SHA-256 từ .part đối chiếu hash đã pin trên download_tasks.
/// 3. Archive extraction fail-closed: Chống Zip Slip, symlink, malformed, và duplicate entries.
/// 4. Manifest identity binding: Bind chính xác chapterVersionId, chapterId, storyId, mediaFormat.
/// 5. Cross-domain Crash Protocol: Phục hồi sau crash giữa rename filesystem và SQLite commit.
/// 6. Canonical READY SSoT: Chỉ đọc offline khi có cả DB row và payload installed hợp lệ.
/// 7. Deterministic Bidirectional Reconciliation: Startup phục hồi tất định mọi trường hợp lệch trạng thái.
/// 8. Idempotent installer: Cài đặt lại an toàn không duplicate/corrupt.
/// 9. Existing-install replacement semantics: Staging biệt lập trước khi atomic swap.
/// 10. Failure cleanup & isolation: Lỗi xóa sạch staging, không tạo DB row, task FAILED.
class BundleInstaller {
  final OfflineStorageRepository _repository;
  final OfflineStoragePaths _storagePaths;
  final ComputeRunner _computeRunner;

  BundleInstaller({
    required OfflineStorageRepository repository,
    required OfflineStoragePaths storagePaths,
    ComputeRunner? computeRunner,
  })  : _repository = repository,
        _storagePaths = storagePaths,
        _computeRunner = computeRunner ?? compute;

  /// Cài đặt gói offline hoàn chỉnh từ tệp `.part` đã tải xong (trạng thái VERIFYING).
  ///
  /// Trả về đối tượng `OfflineChapter` đã được commit vào SQLite thành công.
  /// Thất bại: Ném ngoại lệ `OfflineInstallationException`, cập nhật task `FAILED`, dọn dẹp staging.
  Future<OfflineChapter> installBundle(DownloadTask task) async {
    // Invariant 8 & 9: Kiểm tra nếu bản cài đặt hiện có đã hợp lệ (Idempotency)
    final existingValid = await isAlreadyInstalledAndValid(task.chapterVersionId);
    if (existingValid != null) {
      await _repository.updateTaskStatus(task.taskId, DownloadTaskStatus.ready);
      await _storagePaths.deletePartFile(task.chapterVersionId);
      await _storagePaths.deleteStagingDir(task.chapterVersionId);
      return existingValid;
    }

    final partFile = await _storagePaths.getPartFile(task.chapterVersionId);
    if (!await partFile.exists()) {
      final err = 'Tệp tạm .part không tồn tại: ${partFile.path}';
      await _repository.updateTaskStatus(task.taskId, DownloadTaskStatus.failed, errorMessage: err);
      throw OfflineInstallationException(err);
    }

    final expectedHash = task.sha256Hash;
    if (expectedHash == null || expectedHash.trim().isEmpty) {
      const err = 'Task thiếu mã băm SHA-256 đã pin (Invariant 2 Checksum-before-unzip)';
      await _repository.updateTaskStatus(task.taskId, DownloadTaskStatus.failed, errorMessage: err);
      throw const ChecksumMismatchException(err);
    }

    final stagingPath = await _storagePaths.getStagingPathForVersion(task.chapterVersionId);

    try {
      // 1. Gate 1 & Invariant 2: Checksum-before-unzip trong background isolate
      final actualHash = await _computeRunner(computeFileSha256Isolate, partFile.path);
      if (actualHash.toLowerCase() != expectedHash.trim().toLowerCase()) {
        throw ChecksumMismatchException(
            'Mã băm SHA-256 không khớp! Kỳ vọng: $expectedHash, Thực tế: $actualHash');
      }

      // 2. Dọn sạch staging cũ (nếu có) trước khi giải nén (Gate 5 Staging Isolation)
      await _storagePaths.deleteStagingDir(task.chapterVersionId);

      // 3. Gate 3 & Gate 4 & Invariant 3: Giải nén an toàn trong background isolate
      await _computeRunner(
        safeExtractArchiveIsolate,
        SafeExtractionRequest(
          zipFilePath: partFile.path,
          stagingDirPath: stagingPath,
        ),
      );

      // 4. Gate 2 & Invariant 4: Manifest identity binding & inventory verification
      final manifestFile = File(p.join(stagingPath, 'manifest.json'));
      if (!await manifestFile.exists()) {
        throw const ManifestValidationException('Tệp manifest.json không tồn tại trong gói artifact');
      }

      final manifestContent = await manifestFile.readAsString();
      Map<String, dynamic> manifest;
      try {
        manifest = jsonDecode(manifestContent) as Map<String, dynamic>;
      } catch (e) {
        throw ManifestValidationException('manifest.json không phải là JSON hợp lệ: $e');
      }

      _validateManifestContract(manifest, task, stagingPath);

      // 5. Gate 6 & Invariant 9: Atomic Promotion (staging ➔ installed)
      final installedPath = await _storagePaths.getInstalledPathForVersion(task.chapterVersionId);
      final installedDir = Directory(installedPath);
      if (await installedDir.exists()) {
        await installedDir.delete(recursive: true);
      }

      final stagingDir = Directory(stagingPath);
      await stagingDir.rename(installedPath);

      // 6. Gate 7 & Invariant 5 & 6: Commit SQLite Transaction
      // Đếm số tệp và dung lượng thực tế trong thư mục installed
      int totalFiles = 0;
      int totalBytes = 0;
      final targetInstalledDir = Directory(installedPath);
      for (final entity in targetInstalledDir.listSync(recursive: true)) {
        if (entity is File) {
          totalFiles++;
          totalBytes += entity.lengthSync();
        }
      }

      final rootDir = await _storagePaths.getRootOfflinePath();
      final installedDirRelative = p.relative(installedPath, from: rootDir);

      final offlineChapter = OfflineChapter(
        chapterVersionId: task.chapterVersionId,
        chapterId: task.chapterId,
        storyId: task.storyId,
        storyTitle: task.storyTitle,
        chapterNumber: task.chapterNumber,
        chapterTitle: (manifest['chapterTitle'] as String?) ?? task.storyTitle,
        mediaFormat: task.mediaFormat,
        publicationFormat: manifest['publicationFormat'] as String?,
        installedDir: installedDirRelative,
        totalFiles: totalFiles,
        totalBytes: totalBytes,
        installedAt: DateTime.now().millisecondsSinceEpoch,
        manifestJson: manifestContent,
      );

      // Commit DB
      await _repository.insertOfflineChapter(offlineChapter);

      // Gate 15: Duy nhất BundleInstaller chuyển trạng thái VERIFYING ➔ READY
      await _repository.updateTaskStatus(task.taskId, DownloadTaskStatus.ready);

      // Gate 13: Dọn dẹp tệp tạm .part và staging sau khi cài đặt thành công (Idempotent)
      await _storagePaths.deletePartFile(task.chapterVersionId);
      await _storagePaths.deleteStagingDir(task.chapterVersionId);

      return offlineChapter;
    } catch (e) {
      // Invariant 10: Fail-closed cleanup & task FAILED
      await _storagePaths.deleteStagingDir(task.chapterVersionId);
      await _repository.updateTaskStatus(
        task.taskId,
        DownloadTaskStatus.failed,
        errorMessage: e.toString(),
      );
      rethrow;
    }
  }

  /// Kiểm tra xem chapterVersionId đã được cài đặt hợp lệ trên máy chưa.
  Future<OfflineChapter?> isAlreadyInstalledAndValid(String chapterVersionId) async {
    final chapter = await _repository.getOfflineChapter(chapterVersionId);
    if (chapter == null) return null;

    final installedPath = await _storagePaths.getInstalledPathForVersion(chapterVersionId);
    final manifestFile = File(p.join(installedPath, 'manifest.json'));
    if (!await manifestFile.exists()) return null;

    try {
      final manifest = jsonDecode(await manifestFile.readAsString()) as Map<String, dynamic>;
      if (manifest['chapterVersionId'] != chapterVersionId) return null;
      return chapter;
    } catch (_) {
      return null;
    }
  }

  /// Xác thực hợp đồng Manifest, định danh phiên bản, và đối chiếu toàn bộ inventory tệp trên đĩa.
  void _validateManifestContract(
      Map<String, dynamic> manifest, DownloadTask task, String stagingPath) {
    final schemaVersion = manifest['schemaVersion'];
    if (schemaVersion == null || schemaVersion is! int || schemaVersion < 1) {
      throw const ManifestValidationException('manifest.json thiếu hoặc sai định dạng schemaVersion (yêu cầu >= 1)');
    }

    final chapterVersionId = manifest['chapterVersionId'] as String?;
    if (chapterVersionId != task.chapterVersionId) {
      throw ManifestValidationException(
          'Sai lệch chapterVersionId trong manifest! Kỳ vọng: ${task.chapterVersionId}, Thực tế: $chapterVersionId');
    }

    final chapterId = manifest['chapterId'] as String?;
    if (chapterId != task.chapterId) {
      throw ManifestValidationException(
          'Sai lệch chapterId trong manifest! Kỳ vọng: ${task.chapterId}, Thực tế: $chapterId');
    }

    final storyId = manifest['storyId'] as String?;
    if (storyId != task.storyId) {
      throw ManifestValidationException(
          'Sai lệch storyId trong manifest! Kỳ vọng: ${task.storyId}, Thực tế: $storyId');
    }

    final mediaFormat = (manifest['mediaFormat'] as String?)?.toUpperCase();
    if (mediaFormat != task.mediaFormat.toUpperCase()) {
      throw ManifestValidationException(
          'Sai lệch mediaFormat trong manifest! Kỳ vọng: ${task.mediaFormat}, Thực tế: $mediaFormat');
    }

    // Kiểm tra Novel contentPath nếu là tiểu thuyết
    if (mediaFormat == 'NOVEL') {
      final novelMeta = manifest['novelMetadata'] as Map<String, dynamic>?;
      final contentPath = novelMeta?['contentPath'] as String?;
      if (contentPath == null || contentPath.trim().isEmpty) {
        throw const ManifestValidationException('Novel bundle thiếu novelMetadata.contentPath');
      }
      final novelFile = File(p.join(stagingPath, contentPath));
      if (!novelFile.existsSync()) {
        throw ManifestValidationException('Tệp nội dung tiểu thuyết không tồn tại trên đĩa: $contentPath');
      }
    }

    // Kiểm tra danh sách inventory tệp
    final filesList = manifest['files'];
    if (filesList != null) {
      if (filesList is! List) {
        throw const ManifestValidationException('Trường files trong manifest phải là danh sách');
      }
      for (final item in filesList) {
        if (item is! Map<String, dynamic>) {
          throw const ManifestValidationException('Mỗi entry trong files phải là object');
        }
        final filePath = item['path'] as String?;
        if (filePath == null || filePath.trim().isEmpty) {
          throw const ManifestValidationException('Mỗi entry trong files phải có trường path hợp lệ');
        }
        final localFile = File(p.join(stagingPath, filePath));
        if (!localFile.existsSync()) {
          throw ManifestValidationException('Tệp được khai báo trong manifest không tồn tại trên đĩa: $filePath');
        }
        final declaredSize = item['size'];
        if (declaredSize != null && declaredSize is num) {
          if (localFile.lengthSync() != declaredSize.toInt()) {
            throw ManifestValidationException(
                'Kích thước tệp trên đĩa không khớp manifest cho $filePath (Kỳ vọng: $declaredSize, Thực tế: ${localFile.lengthSync()})');
          }
        }
      }
    }
  }

  // ==========================================
  // DETERMINISTIC BIDIRECTIONAL RECONCILIATION
  // ==========================================

  /// Giao thức Phục hồi Khởi động Hai Chiều (Bidirectional Startup Reconciliation).
  ///
  /// Xử lý tất định mọi failure mode:
  /// - Dọn sạch staging mồ côi (Gate 8).
  /// - DB row tồn tại nhưng payload installed mất hoặc hỏng ➔ Xóa row, fail-closed (Gate 10).
  /// - Thư mục installed tồn tại nhưng DB row thiếu (crash giữa promote và commit) ➔ Tái tạo row nếu hợp lệ (Gate 9) hoặc xóa orphan nếu hỏng (Gate 11).
  /// - Dọn sạch tệp .part còn sót của các chương đã cài thành công (Gate 13).
  Future<ReconciliationReport> reconcileOnStartup() async {
    await _storagePaths.ensureDirectoriesExist();

    int cleanedStagingDirs = 0;
    int removedCorruptedRows = 0;
    int reconstructedRows = 0;
    int removedOrphanDirs = 0;
    int cleanedPartFiles = 0;

    // 1. Gate 8: Dọn sạch mọi thư mục staging mồ côi
    final stagingRootDir = Directory(await _storagePaths.getStagingDirPath());
    if (await stagingRootDir.exists()) {
      for (final entity in stagingRootDir.listSync()) {
        if (entity is Directory) {
          try {
            await entity.delete(recursive: true);
            cleanedStagingDirs++;
          } catch (_) {}
        }
      }
    }

    // 2. Gate 10: DB row vs Installed Filesystem (Row có, file mất/corrupt)
    final allChapters = await _repository.getAllOfflineChapters();
    for (final chapter in allChapters) {
      final installedPath = await _storagePaths.getInstalledPathForVersion(chapter.chapterVersionId);
      final installedDir = Directory(installedPath);
      final manifestFile = File(p.join(installedPath, 'manifest.json'));

      bool isValid = true;
      if (!await installedDir.exists() || !await manifestFile.exists()) {
        isValid = false;
      } else {
        try {
          final manifest = jsonDecode(await manifestFile.readAsString()) as Map<String, dynamic>;
          if (manifest['chapterVersionId'] != chapter.chapterVersionId) {
            isValid = false;
          } else {
            // Kiểm tra các files trong manifest có tồn tại đầy đủ không
            final files = manifest['files'] as List?;
            if (files != null) {
              for (final f in files) {
                final relPath = f['path'] as String?;
                if (relPath == null || !File(p.join(installedPath, relPath)).existsSync()) {
                  isValid = false;
                  break;
                }
              }
            }
          }
        } catch (_) {
          isValid = false;
        }
      }

      if (!isValid) {
        // Fail-closed: Xóa bản ghi CSDL mồ côi
        await _repository.deleteOfflineChapter(chapter.chapterVersionId);
        removedCorruptedRows++;

        // Cập nhật task tương ứng (nếu có) về FAILED
        final task = await _repository.getTaskByVersionId(chapter.chapterVersionId);
        if (task != null && task.status == DownloadTaskStatus.ready) {
          await _repository.updateTaskStatus(
            task.taskId,
            DownloadTaskStatus.failed,
            errorMessage: 'Tệp nội dung cài đặt bị mất hoặc hỏng trên đĩa (Startup Reconcile)',
          );
        }
      }
    }

    // 3. Gate 9 & Gate 11: Installed Filesystem vs DB (Folder có, DB row thiếu)
    final installedRootDir = Directory(await _storagePaths.getInstalledDirPath());
    if (await installedRootDir.exists()) {
      for (final entity in installedRootDir.listSync()) {
        if (entity is Directory) {
          final versionId = p.basename(entity.path);
          final isInstalledInDb = await _repository.isChapterInstalled(versionId);

          if (!isInstalledInDb) {
            // Kiểm tra xem có thể tái tạo (reconstruct) được không
            final manifestFile = File(p.join(entity.path, 'manifest.json'));
            final task = await _repository.getTaskByVersionId(versionId);

            bool canReconstruct = false;
            Map<String, dynamic>? validManifest;
            String? rawManifestJson;

            if (task != null && await manifestFile.exists()) {
              try {
                rawManifestJson = await manifestFile.readAsString();
                validManifest = jsonDecode(rawManifestJson) as Map<String, dynamic>;
                if (validManifest['chapterVersionId'] == task.chapterVersionId &&
                    validManifest['chapterId'] == task.chapterId &&
                    validManifest['storyId'] == task.storyId) {
                  // Kiểm tra files inventory
                  final files = validManifest['files'] as List?;
                  bool allFilesOk = true;
                  if (files != null) {
                    for (final f in files) {
                      final relPath = f['path'] as String?;
                      if (relPath == null || !File(p.join(entity.path, relPath)).existsSync()) {
                        allFilesOk = false;
                        break;
                      }
                    }
                  }
                  if (allFilesOk) {
                    canReconstruct = true;
                  }
                }
              } catch (_) {
                canReconstruct = false;
              }
            }

            if (canReconstruct && task != null && validManifest != null && rawManifestJson != null) {
              // Tái tạo row trong offline_chapters (Gate 9 Crash Recovery)
              int totalFiles = 0;
              int totalBytes = 0;
              for (final sub in entity.listSync(recursive: true)) {
                if (sub is File) {
                  totalFiles++;
                  totalBytes += sub.lengthSync();
                }
              }

              final rootDir = await _storagePaths.getRootOfflinePath();
              final installedDirRelative = p.relative(entity.path, from: rootDir);

              final reconstructed = OfflineChapter(
                chapterVersionId: task.chapterVersionId,
                chapterId: task.chapterId,
                storyId: task.storyId,
                storyTitle: task.storyTitle,
                chapterNumber: task.chapterNumber,
                chapterTitle: (validManifest['chapterTitle'] as String?) ?? task.storyTitle,
                mediaFormat: task.mediaFormat,
                publicationFormat: validManifest['publicationFormat'] as String?,
                installedDir: installedDirRelative,
                totalFiles: totalFiles,
                totalBytes: totalBytes,
                installedAt: DateTime.now().millisecondsSinceEpoch,
                manifestJson: rawManifestJson,
              );

              await _repository.insertOfflineChapter(reconstructed);
              await _repository.updateTaskStatus(task.taskId, DownloadTaskStatus.ready);
              reconstructedRows++;
            } else {
              // Gate 11: Thư mục mồ côi hoặc tệp hỏng không có task ➔ Xóa an toàn
              try {
                await entity.delete(recursive: true);
                removedOrphanDirs++;
              } catch (_) {}
            }
          }
        }
      }
    }

    // 4. Gate 13: Dọn sạch tệp .part còn sót của các chương đã cài thành công
    final tmpDir = Directory(await _storagePaths.getTmpDirPath());
    if (await tmpDir.exists()) {
      for (final entity in tmpDir.listSync()) {
        if (entity is File && entity.path.endsWith('.part')) {
          final versionId = p.basenameWithoutExtension(entity.path);
          if (await _repository.isChapterInstalled(versionId)) {
            try {
              await entity.delete();
              cleanedPartFiles++;
            } catch (_) {}
          }
        }
      }
    }

    return ReconciliationReport(
      cleanedStagingDirs: cleanedStagingDirs,
      removedCorruptedRows: removedCorruptedRows,
      reconstructedRows: reconstructedRows,
      removedOrphanDirs: removedOrphanDirs,
      cleanedPartFiles: cleanedPartFiles,
    );
  }
}
