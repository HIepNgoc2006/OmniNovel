import 'dart:async';
import 'dart:io';
import 'package:dio/dio.dart';
import '../../../core/storage/offline_storage_paths.dart';
import '../models/download_task.dart';
import '../repositories/artifact_repository.dart';
import '../repositories/offline_storage_repository.dart';
import 'artifact_download_client.dart';

/// Quản lý hàng đợi tải ngoại tuyến Durable Offline Download Manager.
///
/// TUÂN THỦ NGHIÊM NGẶT CÁC BẤT BIẾN KIẾN TRÚC:
/// - P0.3: DB-level Single-Flight kết hợp In-Memory Concurrency Mutex.
/// - P0.5: State Machine Ownership: 5D.3 CHỈ sở hữu `QUEUED -> DOWNLOADING -> VERIFYING`.
///   Tuyệt đối KHÔNG tự ý chuyển sang `READY`. (5D.4 BundleInstaller mới sở hữu VERIFYING -> READY).
/// - P0.7: Filesystem là SSoT cho Resume Offset. Kiểm tra `.part.length()`, reconcile SQLite,
///   gửi HTTP Range, chỉ append khi HTTP 206 start == resumeOffset; nếu HTTP 200 thì truncate về 0.
class DownloadQueueManager {
  final OfflineStorageRepository _repository;
  final ArtifactRepository _artifactRepository;
  final ArtifactDownloadClient _downloadClient;
  final OfflineStoragePaths _storagePaths;

  final Map<String, CancelToken> _activeCancelTokens = {};
  final StreamController<DownloadTask> _taskUpdateController =
      StreamController<DownloadTask>.broadcast();

  DownloadQueueManager({
    required OfflineStorageRepository repository,
    required ArtifactRepository artifactRepository,
    required ArtifactDownloadClient downloadClient,
    required OfflineStoragePaths storagePaths,
  })  : _repository = repository,
        _artifactRepository = artifactRepository,
        _downloadClient = downloadClient,
        _storagePaths = storagePaths;

  Stream<DownloadTask> get taskUpdates => _taskUpdateController.stream;

  /// Khởi tạo và thực hiện Crash Recovery khi app bật lại.
  Future<void> initialize() async {
    await _storagePaths.ensureDirectoriesExist();

    // 1. Quét DB và chuyển tất cả task dở dang sang PAUSED (Crash Recovery)
    final pausedCount = await _repository.resetUnfinishedTasksToPaused();

    // 2. Reconcile downloaded_bytes cho các task bị ảnh hưởng theo kích thước thực tế trên đĩa
    if (pausedCount > 0) {
      final pausedTasks = await _repository.getTasksByStatus(DownloadTaskStatus.paused);
      for (final task in pausedTasks) {
        final partFile = await _storagePaths.getPartFile(task.chapterVersionId);
        final actualLength = (await partFile.exists()) ? await partFile.length() : 0;
        if (actualLength != task.downloadedBytes) {
          final fraction = task.totalBytes > 0 ? actualLength / task.totalBytes : 0.0;
          await _repository.updateTaskProgress(
            task.taskId,
            downloadedBytes: actualLength,
            totalBytes: task.totalBytes,
            progressFraction: fraction.clamp(0.0, 1.0),
          );
        }
      }
    }
  }

  /// Thêm một task mới vào hàng đợi tải.
  /// BẤT BIẾN P0.3: Không thể tạo 2 task cho cùng 1 chapterVersionId.
  Future<DownloadTask> enqueueTask({
    required String chapterVersionId,
    required String chapterId,
    required String storyId,
    required String storyTitle,
    required String chapterNumber,
    required String mediaFormat,
    bool autoStart = true,
  }) async {
    // 1. Kiểm tra xem đã có task cho version này chưa
    final existingTask = await _repository.getTaskByVersionId(chapterVersionId);
    if (existingTask != null) {
      if (existingTask.status == DownloadTaskStatus.downloading ||
          existingTask.status == DownloadTaskStatus.verifying ||
          existingTask.status == DownloadTaskStatus.ready) {
        return existingTask;
      }
      // Nếu task cũ ở trạng thái PAUSED / FAILED / CANCELLED, retry lại task cũ (P0.3 reuse task)
      return await retryTask(existingTask.taskId);
    }

    final now = DateTime.now().millisecondsSinceEpoch;
    final task = DownloadTask(
      taskId: 'task_${chapterVersionId}_$now',
      chapterVersionId: chapterVersionId,
      chapterId: chapterId,
      storyId: storyId,
      storyTitle: storyTitle,
      chapterNumber: chapterNumber,
      mediaFormat: mediaFormat,
      status: DownloadTaskStatus.queued,
      createdAt: now,
      updatedAt: now,
    );

    // Ghi vào SQLite - UNIQUE(chapter_version_id) là early guard
    await _repository.insertTask(task);
    _notifyUpdate(task);

    if (autoStart) {
      unawaited(_executeDownload(task.taskId));
    }

    return task;
  }

  /// Tạm dừng tải một task.
  Future<void> pauseTask(String taskId) async {
    final task = await _repository.getTaskById(taskId);
    if (task == null) return;

    if (_activeCancelTokens.containsKey(taskId)) {
      _activeCancelTokens[taskId]?.cancel('User paused download');
      _activeCancelTokens.remove(taskId);
    }

    await _repository.updateTaskStatus(taskId, DownloadTaskStatus.paused);
    final updated = task.copyWith(status: DownloadTaskStatus.paused);
    _notifyUpdate(updated);
  }

  /// Tiếp tục tải một task đang bị tạm dừng hoặc lỗi.
  Future<void> resumeTask(String taskId, {bool autoStart = true}) async {
    final task = await _repository.getTaskById(taskId);
    if (task == null) return;

    if (task.status == DownloadTaskStatus.downloading ||
        task.status == DownloadTaskStatus.verifying) {
      return; // Đang chạy
    }

    await _repository.updateTaskStatus(taskId, DownloadTaskStatus.queued);
    final updated = task.copyWith(
      status: DownloadTaskStatus.queued,
      clearErrorMessage: true,
    );
    _notifyUpdate(updated);

    if (autoStart) {
      unawaited(_executeDownload(taskId));
    }
  }

  /// Thử lại một task thất bại hoặc bị hủy.
  /// BẤT BIẾN P0.3: Tái sử dụng `taskId` cũ, reset số byte và tệp `.part`.
  Future<DownloadTask> retryTask(String taskId, {bool autoStart = true}) async {
    final task = await _repository.getTaskById(taskId);
    if (task == null) {
      throw ArgumentError('Task không tồn tại: $taskId');
    }

    // Xóa tệp .part cũ nếu có
    await _storagePaths.deletePartFile(task.chapterVersionId);

    final now = DateTime.now().millisecondsSinceEpoch;
    final retried = task.copyWith(
      status: DownloadTaskStatus.queued,
      downloadedBytes: 0,
      progressFraction: 0.0,
      clearErrorMessage: true,
      updatedAt: now,
    );

    await _repository.updateTask(retried);
    _notifyUpdate(retried);

    if (autoStart) {
      unawaited(_executeDownload(taskId));
    }
    return retried;
  }

  /// Hủy bỏ tác vụ tải và dọn sạch dữ liệu tạm trên đĩa.
  Future<void> cancelTask(String taskId) async {
    final task = await _repository.getTaskById(taskId);
    if (task == null) return;

    if (_activeCancelTokens.containsKey(taskId)) {
      _activeCancelTokens[taskId]?.cancel('User cancelled download');
      _activeCancelTokens.remove(taskId);
    }

    // Xóa sạch tệp .part và staging
    await _storagePaths.deletePartFile(task.chapterVersionId);
    await _storagePaths.deleteStagingDir(task.chapterVersionId);

    await _repository.updateTaskStatus(taskId, DownloadTaskStatus.cancelled);
    final updated = task.copyWith(status: DownloadTaskStatus.cancelled);
    _notifyUpdate(updated);
  }

  /// Thực thi luồng tải stream an toàn với các chốt chặn P0.2, P0.4, P0.5, P0.7.
  Future<void> _executeDownload(String taskId) async {
    var task = await _repository.getTaskById(taskId);
    if (task == null) return;

    if (_activeCancelTokens.containsKey(taskId)) {
      return; // Task đang chạy, tránh race condition
    }

    final cancelToken = CancelToken();
    _activeCancelTokens[taskId] = cancelToken;

    try {
      // 1. Chuyển trạng thái sang DOWNLOADING
      await _repository.updateTaskStatus(taskId, DownloadTaskStatus.downloading);
      task = task.copyWith(status: DownloadTaskStatus.downloading);
      _notifyUpdate(task);

      // 2. BẤT BIẾN P0.7: Đọc offset thực tế từ Filesystem (SSoT)
      final partFile = await _storagePaths.getPartFile(task.chapterVersionId);
      int resumeOffset = (await partFile.exists()) ? await partFile.length() : 0;

      // Reconcile SQLite trước khi request
      if (resumeOffset != task.downloadedBytes) {
        final fraction = task.totalBytes > 0 ? resumeOffset / task.totalBytes : 0.0;
        await _repository.updateTaskProgress(
          taskId,
          downloadedBytes: resumeOffset,
          totalBytes: task.totalBytes,
          progressFraction: fraction.clamp(0.0, 1.0),
        );
        task = task.copyWith(
          downloadedBytes: resumeOffset,
          progressFraction: fraction.clamp(0.0, 1.0),
        );
        _notifyUpdate(task);
      }

      // 3. Lấy hoặc làm mới Presigned Download URL từ Core API
      String? currentUrl = task.downloadUrl;
      int expectedTotalBytes = task.totalBytes;
      String? expectedSha256 = task.sha256Hash;

      if (currentUrl == null || currentUrl.isEmpty) {
        final artifactInfo = await _artifactRepository.getArtifactInfo(
          chapterId: task.chapterId,
          versionId: task.chapterVersionId,
          cancelToken: cancelToken,
        );

        if (!artifactInfo.isReady) {
          // Artifact chưa sẵn sàng trên backend (đang đóng gói BUILDING)
          await _repository.updateTaskStatus(
            taskId,
            DownloadTaskStatus.queued,
            errorMessage: 'Artifact đang được đóng gói trên server (thử lại sau)',
          );
          _notifyUpdate(task.copyWith(
            status: DownloadTaskStatus.queued,
            errorMessage: 'Artifact đang được đóng gói trên server',
          ));
          _activeCancelTokens.remove(taskId);
          return;
        }

        currentUrl = artifactInfo.downloadUrl!;
        expectedTotalBytes = artifactInfo.fileSizeBytes ?? expectedTotalBytes;
        expectedSha256 = artifactInfo.sha256 ?? expectedSha256;

        await _repository.updateTaskUrl(
          taskId,
          downloadUrl: currentUrl,
          sha256Hash: expectedSha256,
          totalBytes: expectedTotalBytes,
        );
        task = task.copyWith(
          downloadUrl: currentUrl,
          sha256Hash: expectedSha256,
          totalBytes: expectedTotalBytes,
        );
        _notifyUpdate(task);
      }

      // 4. Bắt đầu tải stream từ Storage qua ArtifactDownloadClient (P0.2: Zero JWT)
      Response<ResponseBody> response;
      try {
        response = await _downloadClient.downloadStream(
          currentUrl,
          startByte: resumeOffset,
          cancelToken: cancelToken,
        );
      } on StorageUrlExpiredException {
        // P0.4: URL 403 hết hạn -> làm mới URL qua Core API và thử lại
        final freshInfo = await _artifactRepository.getArtifactInfo(
          chapterId: task.chapterId,
          versionId: task.chapterVersionId,
          cancelToken: cancelToken,
        );
        if (!freshInfo.isReady) {
          throw StateError('Làm mới URL thất bại: artifact chưa READY');
        }
        currentUrl = freshInfo.downloadUrl!;
        await _repository.updateTaskUrl(taskId, downloadUrl: currentUrl);

        // Thử lại stream với URL mới
        response = await _downloadClient.downloadStream(
          currentUrl,
          startByte: resumeOffset,
          cancelToken: cancelToken,
        );
      }

      final statusCode = response.statusCode ?? 200;
      final responseBody = response.data;
      if (responseBody == null) {
        throw StateError('Response body rỗng khi stream download');
      }

      // 5. BẤT BIẾN P0.7: Xử lý HTTP 206 (Append) vs HTTP 200 (Truncate)
      final IOSink sink;
      if (statusCode == 206 && resumeOffset > 0) {
        // Phân tích header Content-Range (ví dụ: bytes 500-999/1000)
        final contentRange = response.headers.value('content-range');
        if (contentRange != null) {
          final rangeMatch = RegExp(r'bytes\s+(\d+)-(\d+)/(\d+|\*)').firstMatch(contentRange);
          if (rangeMatch != null) {
            final rangeStart = int.tryParse(rangeMatch.group(1) ?? '');
            if (rangeStart != null && rangeStart != resumeOffset) {
              // Offset lệch -> fail-closed: truncate tệp và restart từ 0
              await partFile.writeAsBytes([], mode: FileMode.write);
              resumeOffset = 0;
              sink = partFile.openWrite(mode: FileMode.write);
            } else {
              sink = partFile.openWrite(mode: FileMode.append);
            }
          } else {
            sink = partFile.openWrite(mode: FileMode.append);
          }
        } else {
          sink = partFile.openWrite(mode: FileMode.append);
        }
      } else {
        // Máy chủ trả về 200 OK (không hỗ trợ Range hoặc request từ offset 0)
        // Truncate .part về 0 byte để tránh nối file corrupt ZIP
        await partFile.writeAsBytes([], mode: FileMode.write);
        resumeOffset = 0;
        sink = partFile.openWrite(mode: FileMode.write);
      }

      // 6. Đọc stream và cập nhật tiến trình
      int currentDownloadedBytes = resumeOffset;
      var lastProgressUpdate = DateTime.now().millisecondsSinceEpoch;

      try {
        await for (final chunk in responseBody.stream) {
          if (cancelToken.isCancelled) {
            await sink.flush();
            await sink.close();
            return;
          }

          sink.add(chunk);
          currentDownloadedBytes += chunk.length;

          // Throttle ghi DB mỗi 300ms hoặc khi xong
          final now = DateTime.now().millisecondsSinceEpoch;
          if (now - lastProgressUpdate > 300) {
            lastProgressUpdate = now;
            final fraction = expectedTotalBytes > 0
                ? currentDownloadedBytes / expectedTotalBytes
                : 0.0;

            await _repository.updateTaskProgress(
              taskId,
              downloadedBytes: currentDownloadedBytes,
              totalBytes: expectedTotalBytes,
              progressFraction: fraction.clamp(0.0, 1.0),
            );

            task = task!.copyWith(
              downloadedBytes: currentDownloadedBytes,
              progressFraction: fraction.clamp(0.0, 1.0),
            );
            _notifyUpdate(task);
          }
        }

        await sink.flush();
        await sink.close();
      } catch (streamErr) {
        await sink.flush();
        await sink.close();
        rethrow;
      }

      // 7. Hoàn tất tải: BẤT BIẾN P0.5
      // 5D.3 CHỈ chuyển sang VERIFYING. Tuyệt đối KHÔNG chuyển READY!
      final finalFraction = expectedTotalBytes > 0
          ? currentDownloadedBytes / expectedTotalBytes
          : 1.0;

      await _repository.updateTaskProgress(
        taskId,
        downloadedBytes: currentDownloadedBytes,
        totalBytes: expectedTotalBytes > 0 ? expectedTotalBytes : currentDownloadedBytes,
        progressFraction: finalFraction.clamp(0.0, 1.0),
      );

      await _repository.updateTaskStatus(taskId, DownloadTaskStatus.verifying);
      task = task!.copyWith(
        status: DownloadTaskStatus.verifying,
        downloadedBytes: currentDownloadedBytes,
        totalBytes: expectedTotalBytes > 0 ? expectedTotalBytes : currentDownloadedBytes,
        progressFraction: 1.0,
      );
      _notifyUpdate(task);
    } catch (e) {
      if (cancelToken.isCancelled) {
        // Đã được xử lý bởi pause hoặc cancel
        return;
      }

      final errorMsg = e.toString();
      await _repository.updateTaskStatus(
        taskId,
        DownloadTaskStatus.failed,
        errorMessage: errorMsg,
      );
      if (task != null) {
        _notifyUpdate(task.copyWith(
          status: DownloadTaskStatus.failed,
          errorMessage: errorMsg,
        ));
      }
    } finally {
      _activeCancelTokens.remove(taskId);
    }
  }

  void _notifyUpdate(DownloadTask task) {
    if (!_taskUpdateController.isClosed) {
      _taskUpdateController.add(task);
    }
  }

  void dispose() {
    for (final token in _activeCancelTokens.values) {
      token.cancel('Disposing DownloadQueueManager');
    }
    _activeCancelTokens.clear();
    _taskUpdateController.close();
  }
}
