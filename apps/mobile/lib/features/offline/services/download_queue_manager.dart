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
///   gửi HTTP Range, chỉ append khi HTTP 206 start == resumeOffset và total khớp fileSizeBytes;
///   nếu sai range hoặc gặp HTTP 200 thì fail-closed: discard response, truncate .part về 0 và restart từ byte 0.
/// - Concurrency Mutex: Theo dõi active operations bằng Completer; pause/cancel await worker settle
///   trước khi đổi status, loại trừ triệt để race condition với resume/retry.
/// - Metadata Consistency: Verify chapterVersionId, non-null sha256 và positive fileSizeBytes khi URL refresh.
class DownloadQueueManager {
  final OfflineStorageRepository _repository;
  final ArtifactRepository _artifactRepository;
  final ArtifactDownloadClient _downloadClient;
  final OfflineStoragePaths _storagePaths;

  final Map<String, CancelToken> _activeCancelTokens = {};
  final Map<String, Completer<void>> _activeOperations = {};
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
      return await retryTask(existingTask.taskId, autoStart: autoStart);
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

  final Map<String, Completer<void>> _taskActionLocks = {};

  /// Thực thi tuần tự các hành động điều khiển trên cùng một taskId
  Future<T> _runTaskAction<T>(String taskId, Future<T> Function() action) async {
    final previous = _taskActionLocks[taskId]?.future ?? Future<void>.value();
    final completer = Completer<void>();
    _taskActionLocks[taskId] = completer;

    try {
      await previous;
    } catch (_) {}

    try {
      return await action();
    } finally {
      completer.complete();
      if (identical(_taskActionLocks[taskId], completer)) {
        _taskActionLocks.remove(taskId);
      }
    }
  }

  /// Tạm dừng tải một task. Chờ worker cũ settle hoàn toàn trước khi đánh dấu PAUSED.
  Future<void> pauseTask(String taskId) => _runTaskAction(taskId, () async {
    final cancelToken = _activeCancelTokens[taskId];
    final operation = _activeOperations[taskId];

    if (cancelToken != null && !cancelToken.isCancelled) {
      cancelToken.cancel('User paused download');
    }

    // Chờ worker hoàn tất việc đóng file/cleanup trước khi đổi status
    if (operation != null) {
      await operation.future;
    }

    final task = await _repository.getTaskById(taskId);
    if (task == null) return;

    await _repository.updateTaskStatus(taskId, DownloadTaskStatus.paused);
    final updated = task.copyWith(status: DownloadTaskStatus.paused);
    _notifyUpdate(updated);
  });

  /// Tiếp tục tải một task đang bị tạm dừng hoặc lỗi.
  Future<void> resumeTask(String taskId, {bool autoStart = true}) =>
      _runTaskAction(taskId, () async {
    final existingOp = _activeOperations[taskId];
    if (existingOp != null) {
      await existingOp.future;
    }

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
  });

  /// Thử lại một task thất bại hoặc bị hủy.
  /// BẤT BIẾN P0.3: Tái sử dụng `taskId` cũ, reset số byte và tệp `.part`.
  Future<DownloadTask> retryTask(String taskId, {bool autoStart = true}) =>
      _runTaskAction(taskId, () async {
    final cancelToken = _activeCancelTokens[taskId];
    final existingOp = _activeOperations[taskId];

    if (cancelToken != null && !cancelToken.isCancelled) {
      cancelToken.cancel('Retrying task');
    }
    if (existingOp != null) {
      await existingOp.future;
    }

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
  });

  /// Hủy bỏ tác vụ tải và dọn sạch dữ liệu tạm trên đĩa.
  Future<void> cancelTask(String taskId) => _runTaskAction(taskId, () async {
    final cancelToken = _activeCancelTokens[taskId];
    final operation = _activeOperations[taskId];

    if (cancelToken != null && !cancelToken.isCancelled) {
      cancelToken.cancel('User cancelled download');
    }
    if (operation != null) {
      await operation.future;
    }

    final task = await _repository.getTaskById(taskId);
    if (task == null) return;

    // Xóa sạch tệp .part và staging sau khi worker cũ đã settle hoàn toàn
    await _storagePaths.deletePartFile(task.chapterVersionId);
    await _storagePaths.deleteStagingDir(task.chapterVersionId);

    await _repository.updateTaskStatus(taskId, DownloadTaskStatus.cancelled);
    final updated = task.copyWith(status: DownloadTaskStatus.cancelled);
    _notifyUpdate(updated);
  });

  /// Kiểm tra và xác thực tính toàn vẹn của metadata Artifact từ Core API.
  ChapterArtifactInfo _validateArtifactMetadata(
    ChapterArtifactInfo info, {
    required DownloadTask task,
    required String? pinnedSha256,
    required int pinnedTotalBytes,
  }) {
    if (info.chapterVersionId.isNotEmpty &&
        info.chapterVersionId != task.chapterVersionId) {
      throw StateError(
        'Chapter version mismatch: expected ${task.chapterVersionId} but got ${info.chapterVersionId}',
      );
    }

    if (!info.isReady) {
      return info;
    }

    // Với artifact READY, bắt buộc phải có sha256 non-null và fileSizeBytes > 0
    final sha256 = info.sha256;
    final size = info.fileSizeBytes;
    if (sha256 == null || sha256.isEmpty || size == null || size <= 0) {
      throw StateError(
        'Artifact metadata incomplete: READY artifact requires non-null sha256 and positive fileSizeBytes',
      );
    }

    // Nếu metadata đã được pin trước đó, đối chiếu tính bất biến
    if (pinnedSha256 != null && pinnedSha256.isNotEmpty && sha256 != pinnedSha256) {
      throw StateError(
        'Artifact SHA-256 mismatch: previously pinned $pinnedSha256 but got $sha256',
      );
    }

    if (pinnedTotalBytes > 0 && size != pinnedTotalBytes) {
      throw StateError(
        'Artifact fileSizeBytes mismatch: previously pinned $pinnedTotalBytes but got $size',
      );
    }

    return info;
  }

  /// Kiểm tra tính hợp lệ của Content-Range header khi nhận HTTP 206 Partial Content.
  bool _validateContentRange(
    String? contentRange, {
    required int expectedStart,
    required int expectedTotal,
  }) {
    if (contentRange == null || contentRange.isEmpty) {
      return false;
    }
    // Định dạng chuẩn: bytes <start>-<end>/<total>
    final match = RegExp(
      r'^bytes\s+(\d+)-(\d+)/(\d+|\*)$',
      caseSensitive: false,
    ).firstMatch(contentRange.trim());
    if (match == null) {
      return false;
    }
    final start = int.tryParse(match.group(1) ?? '');
    final end = int.tryParse(match.group(2) ?? '');
    final totalStr = match.group(3);

    if (start == null || end == null || start != expectedStart || end < start) {
      return false;
    }

    if (expectedTotal > 0) {
      if (totalStr == '*') {
        return false; // Total bắt buộc phải rõ ràng khi expectedTotal đã được pin
      }
      final total = int.tryParse(totalStr ?? '');
      if (total == null || total != expectedTotal) {
        return false;
      }
      if (end >= total) {
        return false;
      }
    }

    return true;
  }

  /// Thực hiện stream download kèm tự động làm mới presigned URL khi gặp 403.
  Future<Response<ResponseBody>> _fetchStreamWithUrlRefresh({
    required DownloadTask task,
    required String currentUrl,
    required int startByte,
    required CancelToken cancelToken,
    required void Function(String freshUrl, String sha256, int totalBytes) onUrlRefreshed,
  }) async {
    try {
      return await _downloadClient.downloadStream(
        currentUrl,
        startByte: startByte,
        cancelToken: cancelToken,
      );
    } on StorageUrlExpiredException {
      // P0.4: URL 403 hết hạn -> làm mới URL qua Core API và đối chiếu metadata
      final rawFresh = await _artifactRepository.getArtifactInfo(
        chapterId: task.chapterId,
        versionId: task.chapterVersionId,
        cancelToken: cancelToken,
      );

      final freshInfo = _validateArtifactMetadata(
        rawFresh,
        task: task,
        pinnedSha256: task.sha256Hash,
        pinnedTotalBytes: task.totalBytes,
      );

      if (!freshInfo.isReady) {
        throw StateError('Làm mới URL thất bại: artifact chưa READY');
      }

      final freshUrl = freshInfo.downloadUrl!;
      final freshSha = freshInfo.sha256!;
      final freshSize = freshInfo.fileSizeBytes!;

      await _repository.updateTaskUrl(
        task.taskId,
        downloadUrl: freshUrl,
        sha256Hash: freshSha,
        totalBytes: freshSize,
      );

      onUrlRefreshed(freshUrl, freshSha, freshSize);

      return await _downloadClient.downloadStream(
        freshUrl,
        startByte: startByte,
        cancelToken: cancelToken,
      );
    }
  }

  /// Thực thi luồng tải stream an toàn với các chốt chặn P0.2, P0.4, P0.5, P0.7.
  Future<void> _executeDownload(String taskId) async {
    if (_activeOperations.containsKey(taskId)) {
      return; // Đã có worker đang chạy hoặc đang settle
    }

    final completer = Completer<void>();
    _activeOperations[taskId] = completer;
    final cancelToken = CancelToken();
    _activeCancelTokens[taskId] = cancelToken;

    DownloadTask? lastTask;
    try {
      final initialTask = await _repository.getTaskById(taskId);
      if (initialTask == null) return;
      var currentTask = initialTask;
      lastTask = currentTask;

      // 1. Chuyển trạng thái sang DOWNLOADING
      await _repository.updateTaskStatus(taskId, DownloadTaskStatus.downloading);
      currentTask = currentTask.copyWith(status: DownloadTaskStatus.downloading);
      lastTask = currentTask;
      _notifyUpdate(currentTask);

      // 2. BẤT BIẾN P0.7: Đọc offset thực tế từ Filesystem (SSoT)
      final partFile = await _storagePaths.getPartFile(currentTask.chapterVersionId);
      int resumeOffset = (await partFile.exists()) ? await partFile.length() : 0;

      // Reconcile SQLite trước khi request
      if (resumeOffset != currentTask.downloadedBytes) {
        final fraction = currentTask.totalBytes > 0 ? resumeOffset / currentTask.totalBytes : 0.0;
        await _repository.updateTaskProgress(
          taskId,
          downloadedBytes: resumeOffset,
          totalBytes: currentTask.totalBytes,
          progressFraction: fraction.clamp(0.0, 1.0),
        );
        currentTask = currentTask.copyWith(
          downloadedBytes: resumeOffset,
          progressFraction: fraction.clamp(0.0, 1.0),
        );
        lastTask = currentTask;
        _notifyUpdate(currentTask);
      }

      // 3. Lấy hoặc làm mới Presigned Download URL từ Core API
      String? currentUrl = currentTask.downloadUrl;
      int expectedTotalBytes = currentTask.totalBytes;
      String? expectedSha256 = currentTask.sha256Hash;

      if (currentUrl == null || currentUrl.isEmpty) {
        final rawArtifact = await _artifactRepository.getArtifactInfo(
          chapterId: currentTask.chapterId,
          versionId: currentTask.chapterVersionId,
          cancelToken: cancelToken,
        );

        final artifactInfo = _validateArtifactMetadata(
          rawArtifact,
          task: currentTask,
          pinnedSha256: expectedSha256,
          pinnedTotalBytes: expectedTotalBytes,
        );

        if (!artifactInfo.isReady) {
          // Artifact chưa sẵn sàng trên backend (đang đóng gói BUILDING)
          await _repository.updateTaskStatus(
            taskId,
            DownloadTaskStatus.queued,
            errorMessage: 'Artifact đang được đóng gói trên server (thử lại sau)',
          );
          _notifyUpdate(currentTask.copyWith(
            status: DownloadTaskStatus.queued,
            errorMessage: 'Artifact đang được đóng gói trên server',
          ));
          return;
        }

        currentUrl = artifactInfo.downloadUrl!;
        expectedTotalBytes = artifactInfo.fileSizeBytes!;
        expectedSha256 = artifactInfo.sha256!;

        await _repository.updateTaskUrl(
          taskId,
          downloadUrl: currentUrl,
          sha256Hash: expectedSha256,
          totalBytes: expectedTotalBytes,
        );
        currentTask = currentTask.copyWith(
          downloadUrl: currentUrl,
          sha256Hash: expectedSha256,
          totalBytes: expectedTotalBytes,
        );
        lastTask = currentTask;
        _notifyUpdate(currentTask);
      }

      void onUrlRefreshed(String freshUrl, String sha, int totalBytes) {
        currentUrl = freshUrl;
        expectedSha256 = sha;
        expectedTotalBytes = totalBytes;
        currentTask = currentTask.copyWith(
          downloadUrl: freshUrl,
          sha256Hash: sha,
          totalBytes: totalBytes,
        );
        lastTask = currentTask;
        _notifyUpdate(currentTask);
      }

      // 4. Bắt đầu tải stream từ Storage qua ArtifactDownloadClient (P0.2: Zero JWT)
      Response<ResponseBody> response;
      bool shouldAppend = false;

      if (resumeOffset > 0) {
        response = await _fetchStreamWithUrlRefresh(
          task: currentTask,
          currentUrl: currentUrl!,
          startByte: resumeOffset,
          cancelToken: cancelToken,
          onUrlRefreshed: onUrlRefreshed,
        );

        final statusCode = response.statusCode ?? 200;
        if (statusCode == 206) {
          final contentRange = response.headers.value('content-range');
          final isValidRange = _validateContentRange(
            contentRange,
            expectedStart: resumeOffset,
            expectedTotal: expectedTotalBytes,
          );

          if (isValidRange) {
            shouldAppend = true;
          } else {
            // P0 FAIL-CLOSED: Discard response 206 sai range/total, truncate .part về 0, restart từ byte 0
            await partFile.writeAsBytes([], mode: FileMode.write);
            resumeOffset = 0;

            await _repository.updateTaskProgress(
              taskId,
              downloadedBytes: 0,
              totalBytes: expectedTotalBytes,
              progressFraction: 0.0,
            );
            currentTask = currentTask.copyWith(downloadedBytes: 0, progressFraction: 0.0);
            lastTask = currentTask;
            _notifyUpdate(currentTask);

            // Gửi request mới từ byte 0 (không tái sử dụng body 206 cũ)
            response = await _fetchStreamWithUrlRefresh(
              task: currentTask,
              currentUrl: currentUrl!,
              startByte: 0,
              cancelToken: cancelToken,
              onUrlRefreshed: onUrlRefreshed,
            );
            shouldAppend = false;
          }
        } else {
          // Máy chủ trả về 200 OK (bỏ qua Range) -> truncate .part và ghi từ byte 0
          await partFile.writeAsBytes([], mode: FileMode.write);
          resumeOffset = 0;
          shouldAppend = false;
        }
      } else {
        // Tải mới từ byte 0
        await partFile.writeAsBytes([], mode: FileMode.write);
        resumeOffset = 0;
        response = await _fetchStreamWithUrlRefresh(
          task: currentTask,
          currentUrl: currentUrl!,
          startByte: 0,
          cancelToken: cancelToken,
          onUrlRefreshed: onUrlRefreshed,
        );
        shouldAppend = false;
      }

      final responseBody = response.data;
      if (responseBody == null) {
        throw StateError('Response body rỗng khi stream download');
      }

      final IOSink sink = partFile.openWrite(
        mode: shouldAppend ? FileMode.append : FileMode.write,
      );

      // 5. Đọc stream và cập nhật tiến trình
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

            currentTask = currentTask.copyWith(
              downloadedBytes: currentDownloadedBytes,
              progressFraction: fraction.clamp(0.0, 1.0),
            );
            lastTask = currentTask;
            _notifyUpdate(currentTask);
          }
        }

        await sink.flush();
        await sink.close();
      } catch (streamErr) {
        try {
          await sink.flush();
          await sink.close();
        } catch (_) {}
        rethrow;
      }

      // 6. Hoàn tất tải: BẤT BIẾN P0.5
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
      currentTask = currentTask.copyWith(
        status: DownloadTaskStatus.verifying,
        downloadedBytes: currentDownloadedBytes,
        totalBytes: expectedTotalBytes > 0 ? expectedTotalBytes : currentDownloadedBytes,
        progressFraction: 1.0,
      );
      lastTask = currentTask;
      _notifyUpdate(currentTask);
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
      final failedTask = lastTask;
      if (failedTask != null) {
        _notifyUpdate(failedTask.copyWith(
          status: DownloadTaskStatus.failed,
          errorMessage: errorMsg,
        ));
      }
    } finally {
      _activeCancelTokens.remove(taskId);
      _activeOperations.remove(taskId);
      if (!completer.isCompleted) {
        completer.complete();
      }
    }
  }

  void _notifyUpdate(DownloadTask task) {
    if (!_taskUpdateController.isClosed) {
      _taskUpdateController.add(task);
    }
  }

  void dispose() {
    for (final token in _activeCancelTokens.values) {
      if (!token.isCancelled) {
        token.cancel('Disposing DownloadQueueManager');
      }
    }
    _activeCancelTokens.clear();
    _activeOperations.clear();
    _taskUpdateController.close();
  }
}
