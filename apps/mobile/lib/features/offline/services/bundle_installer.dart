import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
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

/// Tác vụ cài đặt bị hủy bởi người dùng trong khi đang giải nén/xác thực.
class OfflineInstallationCancelledException extends OfflineInstallationException {
  const OfflineInstallationCancelledException(super.message);
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
// DATA TRANSFER OBJECTS FOR ISOLATE & VALIDATION
// ==========================================

/// Kết quả xác thực toàn vẹn của payload đã cài đặt hoặc staging.
class PayloadValidationResult {
  final bool isValid;
  final String? errorMessage;
  final Map<String, dynamic>? manifest;
  final String? rawManifestJson;
  final int totalFiles;
  final int totalBytes;

  const PayloadValidationResult.valid({
    required this.manifest,
    required this.rawManifestJson,
    required this.totalFiles,
    required this.totalBytes,
  })  : isValid = true,
        errorMessage = null;

  const PayloadValidationResult.invalid(this.errorMessage)
      : isValid = false,
        manifest = null,
        rawManifestJson = null,
        totalFiles = 0,
        totalBytes = 0;
}

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
  final decoder = ZipDecoder();
  Archive archive;
  try {
    archive = decoder.decodeBytes(bytes, verify: true);
  } catch (e) {
    throw UnsafeArchiveException('Tệp ZIP bị hỏng hoặc sai định dạng: $e');
  }

  // Quét Central Directory Headers để chặn duplicate paths và symlinks ngay từ header level
  final seenHeaderPaths = <String>{};
  for (final header in decoder.directory.fileHeaders) {
    final mode = (header.externalFileAttributes ?? 0) >> 16;
    if ((mode & 0xF000) == 0xA000) {
      throw const UnsafeArchiveException('Phát hiện symlink/hardlink không an toàn trong tệp nén');
    }
    final rawHeaderName = header.filename.replaceAll('\\', '/');
    if (seenHeaderPaths.contains(rawHeaderName)) {
      throw UnsafeArchiveException('Phát hiện đường dẫn trùng lặp trong tệp nén: ${header.filename}');
    }
    seenHeaderPaths.add(rawHeaderName);
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

    // Chặn duplicate paths và xung đột file-vs-directory
    if (seenPaths.contains(destCanonical)) {
      throw UnsafeArchiveException('Phát hiện đường dẫn trùng lặp trong tệp nén: ${entry.name}');
    }
    seenPaths.add(destCanonical);

    if (entry.isFile) {
      if (Directory(destCanonical).existsSync()) {
        throw UnsafeArchiveException('Xung đột entry tệp đè lên thư mục đã tồn tại: ${entry.name}');
      }
      final parentDir = Directory(p.dirname(destCanonical));
      if (!parentDir.existsSync()) {
        parentDir.createSync(recursive: true);
      }
      final outFile = File(destCanonical);
      outFile.writeAsBytesSync(entry.content as List<int>, flush: true);
    } else {
      if (File(destCanonical).existsSync()) {
        throw UnsafeArchiveException('Xung đột entry thư mục đè lên tệp đã tồn tại: ${entry.name}');
      }
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
/// 10. Failure cleanup & isolation: Lỗi xóa sạch staging, không tạo DB row, task FAILED.
class BundleInstaller {
  final OfflineStorageRepository _repository;
  final OfflineStoragePaths _storagePaths;
  final ComputeRunner _computeRunner;

  String get userId => _repository.userId;

  BundleInstaller({
    required OfflineStorageRepository repository,
    required OfflineStoragePaths storagePaths,
    ComputeRunner? computeRunner,
  })  : _repository = repository,
        _storagePaths = storagePaths,
        _computeRunner = computeRunner ?? compute {
    if (repository.userId != storagePaths.userId) {
      throw ArgumentError(
        'Identity Mismatch: repository.userId (${repository.userId}) != storagePaths.userId (${storagePaths.userId})',
      );
    }
  }

  /// Cài đặt gói offline hoàn chỉnh từ tệp `.part` đã tải xong (trạng thái VERIFYING).
  ///
  /// Trả về đối tượng `OfflineChapter` đã được commit vào SQLite thành công.
  /// Thất bại: Ném ngoại lệ `OfflineInstallationException`, cập nhật task `FAILED`, dọn dẹp staging.
  Future<OfflineChapter> installBundle(
    DownloadTask task, {
    CancelToken? cancelToken,
  }) async {
    void checkCancelled() {
      if (cancelToken != null && cancelToken.isCancelled) {
        throw const OfflineInstallationCancelledException('Tác vụ cài đặt bị hủy bởi người dùng');
      }
    }

    checkCancelled();

    // Invariant 8 & 9: Kiểm tra nếu bản cài đặt hiện có đã hợp lệ (Idempotency)
    final existingValid = await isAlreadyInstalledAndValid(task.chapterVersionId);
    if (existingValid != null) {
      checkCancelled();
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
    bool isPromoted = false;
    String? promotedInstalledPath;

    try {
      // 1. Gate 1 & Invariant 2: Checksum-before-unzip trong background isolate
      final actualHash = await _computeRunner(computeFileSha256Isolate, partFile.path);
      if (actualHash.toLowerCase() != expectedHash.trim().toLowerCase()) {
        throw ChecksumMismatchException(
            'Mã băm SHA-256 không khớp! Kỳ vọng: $expectedHash, Thực tế: $actualHash');
      }

      checkCancelled();

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

      checkCancelled();

      // 4. Gate 2 & Invariant 4: Manifest identity binding & canonical payload verification
      final stagingDir = Directory(stagingPath);
      final validation = await verifyInstalledPayload(
        stagingDir,
        expectedVersionId: task.chapterVersionId,
        expectedChapterId: task.chapterId,
        expectedStoryId: task.storyId,
        expectedMediaFormat: task.mediaFormat,
        verifyFileHashes: true,
      );

      if (!validation.isValid) {
        throw ManifestValidationException(validation.errorMessage ?? 'Payload xác thực không hợp lệ');
      }

      final manifest = validation.manifest!;
      final manifestContent = validation.rawManifestJson!;

      checkCancelled();

      // 5. Gate 6 & Invariant 9: Atomic Promotion (staging ➔ installed)
      final installedPath = await _storagePaths.getInstalledPathForVersion(task.chapterVersionId);
      final installedDir = Directory(installedPath);
      if (await installedDir.exists()) {
        await installedDir.delete(recursive: true);
      }

      await stagingDir.rename(installedPath);
      isPromoted = true;
      promotedInstalledPath = installedPath;

      checkCancelled();

      // 6. Gate 7 & Invariant 5 & 6: Commit SQLite Transaction
      final rootDir = await _storagePaths.getRootOfflinePath();
      final installedDirRelative = p.relative(installedPath, from: rootDir);

      final offlineChapter = OfflineChapter(
        userId: task.userId,
        chapterVersionId: task.chapterVersionId,
        chapterId: task.chapterId,
        storyId: task.storyId,
        storyTitle: task.storyTitle,
        chapterNumber: task.chapterNumber,
        chapterTitle: (manifest['chapterTitle'] as String?) ?? task.storyTitle,
        mediaFormat: task.mediaFormat,
        publicationFormat: manifest['publicationFormat'] as String?,
        installedDir: installedDirRelative,
        totalFiles: validation.totalFiles,
        totalBytes: validation.totalBytes,
        installedAt: DateTime.now().millisecondsSinceEpoch,
        manifestJson: manifestContent,
      );

      // Commit DB & Task READY in one atomic SQLite Transaction!
      await _repository.commitInstalledChapterAndReady(offlineChapter, task.taskId);
      isPromoted = false; // Commit thành công, không rollback installed nữa

      // Gate 13: Dọn dẹp tệp tạm .part và staging sau khi cài đặt thành công (Idempotent)
      await _storagePaths.deletePartFile(task.chapterVersionId);
      await _storagePaths.deleteStagingDir(task.chapterVersionId);

      return offlineChapter;
    } on OfflineInstallationCancelledException {
      // Invariant 10: Fail-closed cleanup khi bị cancel, KHÔNG ghi status FAILED
      await _storagePaths.deleteStagingDir(task.chapterVersionId);
      if (isPromoted && promotedInstalledPath != null) {
        try {
          final dir = Directory(promotedInstalledPath);
          if (await dir.exists()) {
            await dir.delete(recursive: true);
          }
        } catch (_) {}
      }
      rethrow;
    } catch (e) {
      // Invariant 10: Fail-closed cleanup & task FAILED
      await _storagePaths.deleteStagingDir(task.chapterVersionId);
      if (isPromoted && promotedInstalledPath != null) {
        try {
          final dir = Directory(promotedInstalledPath);
          if (await dir.exists()) {
            await dir.delete(recursive: true);
          }
        } catch (_) {}
      }
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
    final installedDir = Directory(installedPath);

    final validation = await verifyInstalledPayload(
      installedDir,
      expectedVersionId: chapterVersionId,
      expectedChapterId: chapter.chapterId,
      expectedStoryId: chapter.storyId,
      expectedMediaFormat: chapter.mediaFormat,
      verifyFileHashes: true,
    );

    if (validation.isValid) {
      return chapter;
    }
    return null;
  }

  /// Hàm xác thực chuẩn Canonical (Single Source of Truth) cho payload đã cài đặt hoặc staging.
  /// Được dùng chung 100% giữa Fresh Install, Idempotency Check, và Startup Reconciliation.
  Future<PayloadValidationResult> verifyInstalledPayload(
    Directory rootDir, {
    String? expectedVersionId,
    String? expectedChapterId,
    String? expectedStoryId,
    String? expectedMediaFormat,
    bool verifyFileHashes = true,
  }) async {
    if (!await rootDir.exists()) {
      return const PayloadValidationResult.invalid('Thư mục payload không tồn tại');
    }

    final canonicalRoot = p.canonicalize(rootDir.path);
    final manifestFile = File(p.join(canonicalRoot, 'manifest.json'));
    if (!await manifestFile.exists()) {
      return const PayloadValidationResult.invalid('Tệp manifest.json không tồn tại');
    }

    final String rawManifest;
    final Map<String, dynamic> manifest;
    try {
      rawManifest = await manifestFile.readAsString();
      manifest = jsonDecode(rawManifest) as Map<String, dynamic>;
    } catch (e) {
      return PayloadValidationResult.invalid('manifest.json không phải JSON hợp lệ: $e');
    }

    // 1. Schema version
    final schemaVersion = manifest['schemaVersion'];
    if (schemaVersion == null || schemaVersion is! int || schemaVersion < 1) {
      return const PayloadValidationResult.invalid('manifest.json thiếu hoặc sai schemaVersion (yêu cầu >= 1)');
    }

    // 2. Identity binding
    final chapterVersionId = manifest['chapterVersionId'] as String?;
    if (chapterVersionId == null || chapterVersionId.isEmpty) {
      return const PayloadValidationResult.invalid('manifest.json thiếu chapterVersionId');
    }
    if (expectedVersionId != null && chapterVersionId != expectedVersionId) {
      return PayloadValidationResult.invalid(
          'Sai lệch chapterVersionId trong manifest! Kỳ vọng: $expectedVersionId, Thực tế: $chapterVersionId');
    }

    final chapterId = manifest['chapterId'] as String?;
    if (expectedChapterId != null && chapterId != expectedChapterId) {
      return PayloadValidationResult.invalid(
          'Sai lệch chapterId trong manifest! Kỳ vọng: $expectedChapterId, Thực tế: $chapterId');
    }

    final storyId = manifest['storyId'] as String?;
    if (expectedStoryId != null && storyId != expectedStoryId) {
      return PayloadValidationResult.invalid(
          'Sai lệch storyId trong manifest! Kỳ vọng: $expectedStoryId, Thực tế: $storyId');
    }

    final mediaFormat = (manifest['mediaFormat'] as String?)?.toUpperCase();
    if (mediaFormat != 'COMIC' && mediaFormat != 'NOVEL') {
      return PayloadValidationResult.invalid('mediaFormat không hợp lệ trong manifest: $mediaFormat');
    }
    if (expectedMediaFormat != null && mediaFormat != expectedMediaFormat.toUpperCase()) {
      return PayloadValidationResult.invalid(
          'Sai lệch mediaFormat trong manifest! Kỳ vọng: $expectedMediaFormat, Thực tế: $mediaFormat');
    }

    // 3. Bundle type (OFFLINE_READER)
    final bundleType = manifest['bundleType'];
    if (bundleType != null && bundleType != 'OFFLINE_READER') {
      return PayloadValidationResult.invalid('bundleType không hợp lệ: $bundleType (yêu cầu OFFLINE_READER)');
    }

    // 4. Novel metadata containment
    if (mediaFormat == 'NOVEL') {
      final novelMeta = manifest['novelMetadata'] as Map<String, dynamic>?;
      final contentPath = novelMeta?['contentPath'] as String?;
      if (contentPath == null || contentPath.trim().isEmpty) {
        return const PayloadValidationResult.invalid('Novel bundle thiếu novelMetadata.contentPath');
      }

      // Check containment
      final rawPath = contentPath.replaceAll('\\', '/');
      if (rawPath.startsWith('/') || rawPath.contains(':')) {
        return PayloadValidationResult.invalid('novelMetadata.contentPath là đường dẫn tuyệt đối nguy hại: $contentPath');
      }
      final normContentPath = p.normalize(rawPath);
      if (normContentPath == '..' || normContentPath.startsWith('../') || normContentPath.startsWith('..\\') || p.isAbsolute(normContentPath)) {
        return PayloadValidationResult.invalid('novelMetadata.contentPath chứa path traversal: $contentPath');
      }
      final canonicalContentPath = p.canonicalize(p.join(canonicalRoot, normContentPath));
      if (!canonicalContentPath.startsWith(canonicalRoot + p.separator) && canonicalContentPath != canonicalRoot) {
        return PayloadValidationResult.invalid('novelMetadata.contentPath thoát khỏi thư mục root: $contentPath');
      }

      final novelFile = File(canonicalContentPath);
      if (!await novelFile.exists()) {
        return PayloadValidationResult.invalid('Tệp nội dung tiểu thuyết không tồn tại trên đĩa: $contentPath');
      }
    }

    // 5. Files list validation
    final filesList = manifest['files'];
    if (filesList == null || filesList is! List || filesList.isEmpty) {
      return const PayloadValidationResult.invalid('manifest.json phải chứa danh sách files không rỗng');
    }

    final Set<String> declaredCanonicalPaths = {};
    int countedTotalFiles = 0;
    int countedTotalBytes = 0;

    for (final item in filesList) {
      if (item is! Map<String, dynamic>) {
        return const PayloadValidationResult.invalid('Mỗi entry trong files phải là JSON object');
      }

      final filePath = item['path'] as String?;
      if (filePath == null || filePath.trim().isEmpty) {
        return const PayloadValidationResult.invalid('Mỗi entry trong files phải có trường path hợp lệ');
      }

      // Path containment check
      final rawPath = filePath.replaceAll('\\', '/');
      if (rawPath.startsWith('/') || rawPath.contains(':')) {
        return PayloadValidationResult.invalid('Tệp trong manifest có đường dẫn tuyệt đối nguy hại: $filePath');
      }
      final normalized = p.normalize(rawPath);
      if (normalized == '..' || normalized.startsWith('../') || normalized.startsWith('..\\') || p.isAbsolute(normalized)) {
        return PayloadValidationResult.invalid('Tệp trong manifest chứa path traversal (Zip Slip): $filePath');
      }
      final canonicalFilePath = p.canonicalize(p.join(canonicalRoot, normalized));
      if (!canonicalFilePath.startsWith(canonicalRoot + p.separator) && canonicalFilePath != canonicalRoot) {
        return PayloadValidationResult.invalid('Tệp trong manifest thoát khỏi thư mục root: $filePath');
      }

      if (declaredCanonicalPaths.contains(canonicalFilePath)) {
        return PayloadValidationResult.invalid('manifest chứa đường dẫn trùng lặp: $filePath');
      }
      declaredCanonicalPaths.add(canonicalFilePath);

      final localFile = File(canonicalFilePath);
      if (!await localFile.exists()) {
        return PayloadValidationResult.invalid('Tệp khai báo trong manifest không tồn tại trên đĩa: $filePath');
      }

      final declaredSize = item['size'];
      if (declaredSize == null || declaredSize is! num || declaredSize < 0) {
        return PayloadValidationResult.invalid('Tệp $filePath thiếu hoặc sai trường size trong manifest');
      }
      final actualLength = await localFile.length();
      if (actualLength != declaredSize.toInt()) {
        return PayloadValidationResult.invalid(
            'Kích thước tệp trên đĩa không khớp manifest cho $filePath (Kỳ vọng: $declaredSize, Thực tế: $actualLength)');
      }

      if (verifyFileHashes) {
        final declaredSha256 = item['sha256'] as String?;
        if (declaredSha256 == null || declaredSha256.trim().isEmpty) {
          return PayloadValidationResult.invalid('Tệp $filePath thiếu mã băm sha256 trong manifest');
        }
        // Tính SHA-256 thực tế của tệp
        final stream = localFile.openRead();
        final digest = await sha256.bind(stream).first;
        final actualSha = digest.toString().toLowerCase();
        if (actualSha != declaredSha256.trim().toLowerCase()) {
          return PayloadValidationResult.invalid(
              'Mã băm SHA-256 tệp $filePath bị sai lệch! Kỳ vọng: $declaredSha256, Thực tế: $actualSha');
        }
      }

      countedTotalFiles++;
      countedTotalBytes += actualLength;
    }

    // 6. Exact Disk Inventory Check (Reject extra untrusted files)
    final allDiskEntities = rootDir.listSync(recursive: true);
    for (final entity in allDiskEntities) {
      if (entity is File) {
        final canonicalEntity = p.canonicalize(entity.path);
        if (canonicalEntity == p.canonicalize(manifestFile.path)) {
          continue; // manifest.json hợp lệ
        }
        if (!declaredCanonicalPaths.contains(canonicalEntity)) {
          final rel = p.relative(canonicalEntity, from: canonicalRoot);
          return PayloadValidationResult.invalid('Phát hiện tệp lạ không được khai báo trong manifest: $rel');
        }
      }
    }

    return PayloadValidationResult.valid(
      manifest: manifest,
      rawManifestJson: rawManifest,
      totalFiles: countedTotalFiles,
      totalBytes: countedTotalBytes,
    );
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

    // 2. Gate 10: DB row vs Installed Filesystem (Row có, file mất/corrupt/tampered)
    final allChapters = await _repository.getAllOfflineChapters();
    for (final chapter in allChapters) {
      final installedPath = await _storagePaths.getInstalledPathForVersion(chapter.chapterVersionId);
      final installedDir = Directory(installedPath);

      final validation = await verifyInstalledPayload(
        installedDir,
        expectedVersionId: chapter.chapterVersionId,
        expectedChapterId: chapter.chapterId,
        expectedStoryId: chapter.storyId,
        expectedMediaFormat: chapter.mediaFormat,
        verifyFileHashes: true,
      );

      if (!validation.isValid) {
        // Fail-closed: Xóa bản ghi CSDL mồ côi hoặc hỏng
        await _repository.deleteOfflineChapter(chapter.chapterVersionId);
        removedCorruptedRows++;

        // Cập nhật task tương ứng (nếu có) về FAILED
        final task = await _repository.getTaskByVersionId(chapter.chapterVersionId);
        if (task != null && task.status != DownloadTaskStatus.failed) {
          await _repository.updateTaskStatus(
            task.taskId,
            DownloadTaskStatus.failed,
            errorMessage: 'Tệp nội dung cài đặt bị mất hoặc hỏng trên đĩa (Startup Reconcile: ${validation.errorMessage})',
          );
        }
      } else {
        // Invariant 5/7: Payload 100% hợp lệ + DB row tồn tại -> Normalize task về READY CHỈ KHI task đang ở PAUSED hoặc VERIFYING do crash recovery
        final task = await _repository.getTaskByVersionId(chapter.chapterVersionId);
        if (task != null &&
            (task.status == DownloadTaskStatus.paused || task.status == DownloadTaskStatus.verifying)) {
          await _repository.updateTaskStatus(task.taskId, DownloadTaskStatus.ready);
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
            final task = await _repository.getTaskByVersionId(versionId);
            final isRecoverable = task != null &&
                (task.status == DownloadTaskStatus.verifying || task.status == DownloadTaskStatus.paused);

            if (isRecoverable) {
              final validation = await verifyInstalledPayload(
                entity,
                expectedVersionId: task.chapterVersionId,
                expectedChapterId: task.chapterId,
                expectedStoryId: task.storyId,
                expectedMediaFormat: task.mediaFormat,
                verifyFileHashes: true,
              );

              if (validation.isValid) {
                // Tái tạo row trong offline_chapters (Gate 9 Crash Recovery)
                final rootDir = await _storagePaths.getRootOfflinePath();
                final installedDirRelative = p.relative(entity.path, from: rootDir);

                final reconstructed = OfflineChapter(
                  userId: task.userId,
                  chapterVersionId: task.chapterVersionId,
                  chapterId: task.chapterId,
                  storyId: task.storyId,
                  storyTitle: task.storyTitle,
                  chapterNumber: task.chapterNumber,
                  chapterTitle: (validation.manifest!['chapterTitle'] as String?) ?? task.storyTitle,
                  mediaFormat: task.mediaFormat,
                  publicationFormat: validation.manifest!['publicationFormat'] as String?,
                  installedDir: installedDirRelative,
                  totalFiles: validation.totalFiles,
                  totalBytes: validation.totalBytes,
                  installedAt: DateTime.now().millisecondsSinceEpoch,
                  manifestJson: validation.rawManifestJson!,
                );

                await _repository.commitInstalledChapterAndReady(reconstructed, task.taskId);
                reconstructedRows++;
              } else {
                // Gate 11: Hỏng payload ➔ Xóa an toàn
                try {
                  await entity.delete(recursive: true);
                  removedOrphanDirs++;
                } catch (_) {}
              }
            } else {
              // Task không ở trạng thái recoverable (CANCELLED, FAILED, QUEUED) hoặc không có task:
              // Xóa an toàn thư mục orphan trên đĩa, bảo toàn trạng thái hiện tại của task (chống resurrection race)
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
