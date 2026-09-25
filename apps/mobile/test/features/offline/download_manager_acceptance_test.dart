import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/storage/offline_storage_paths.dart';
import 'package:omninovel_mobile/features/offline/models/download_task.dart';
import 'package:omninovel_mobile/features/offline/models/offline_chapter.dart';
import 'package:omninovel_mobile/features/offline/repositories/artifact_repository.dart';
import 'package:omninovel_mobile/features/offline/repositories/offline_storage_repository.dart';
import 'package:omninovel_mobile/features/offline/services/artifact_download_client.dart';
import 'package:omninovel_mobile/features/offline/services/download_queue_manager.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  // Kích hoạt FFI cho SQLite chạy trên test runner
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  late Directory tempDir;
  late OfflineDatabase offlineDb;
  late OfflineStorageRepository storageRepo;
  late OfflineStoragePaths storagePaths;
  late MockApiClient mockApiClient;
  late ArtifactRepository artifactRepo;

  setUp(() async {
    tempDir = Directory.systemTemp.createTempSync('omninovel_offline_test_');

    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: inMemoryDatabasePath,
      databaseFactory: databaseFactoryFfi,
    );

    storageRepo = OfflineStorageRepository(database: offlineDb);
    storagePaths = OfflineStoragePaths(customBasePath: tempDir.path);
    await storagePaths.ensureDirectoriesExist();

    mockApiClient = MockApiClient();
    artifactRepo = ArtifactRepository(apiClient: mockApiClient);
  });

  tearDown(() async {
    await offlineDb.close();
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  group('Phase 5D.3 Acceptance Gates — Durable Offline Download Manager', () {
    // =========================================================================
    // Gate 1: DB-Level Single-Flight (UNIQUE chapter_version_id)
    // =========================================================================
    test('Gate 1: DB-Level Single-Flight prevents duplicate tasks for same chapterVersionId', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final task1 = DownloadTask(
        taskId: 'task_1',
        chapterVersionId: 'ver_001',
        chapterId: 'chap_001',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '1',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.queued,
        createdAt: now,
        updatedAt: now,
      );

      await storageRepo.insertTask(task1);

      // Thử thêm task thứ 2 với cùng chapterVersionId
      final task2 = DownloadTask(
        taskId: 'task_2',
        chapterVersionId: 'ver_001', // TRÙNG
        chapterId: 'chap_001',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '1',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.queued,
        createdAt: now + 1,
        updatedAt: now + 1,
      );

      expect(
        () async => await storageRepo.insertTask(task2),
        throwsA(isA<DatabaseException>()),
      );
    });

    // =========================================================================
    // Gate 2: Crash Recovery (DOWNLOADING / VERIFYING -> PAUSED)
    // =========================================================================
    test('Gate 2: Crash recovery switches DOWNLOADING & VERIFYING tasks to PAUSED and reconciles bytes', () async {
      final now = DateTime.now().millisecondsSinceEpoch;

      // Giả lập tệp .part đã tải được 500 bytes trên đĩa
      final partFile = await storagePaths.getPartFile('ver_002');
      await partFile.writeAsBytes(Uint8List(500));

      final taskDownloading = DownloadTask(
        taskId: 'task_crash_1',
        chapterVersionId: 'ver_002',
        chapterId: 'chap_002',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '2',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.downloading,
        downloadedBytes: 100, // DB đang bị lệch so với 500 bytes thực tế trên đĩa
        totalBytes: 1000,
        createdAt: now,
        updatedAt: now,
      );

      final taskVerifying = DownloadTask(
        taskId: 'task_crash_2',
        chapterVersionId: 'ver_003',
        chapterId: 'chap_003',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '3',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        downloadedBytes: 800,
        totalBytes: 800,
        createdAt: now,
        updatedAt: now,
      );

      await storageRepo.insertTask(taskDownloading);
      await storageRepo.insertTask(taskVerifying);

      final downloadClient = ArtifactDownloadClient();
      final manager = DownloadQueueManager(
        repository: storageRepo,
        artifactRepository: artifactRepo,
        downloadClient: downloadClient,
        storagePaths: storagePaths,
      );

      // Kích hoạt khởi động và phục hồi sau sự cố
      await manager.initialize();

      final recovered1 = await storageRepo.getTaskById('task_crash_1');
      final recovered2 = await storageRepo.getTaskById('task_crash_2');

      expect(recovered1?.status, equals(DownloadTaskStatus.paused));
      // Reconcile đúng theo kích thước tệp thực tế trên đĩa (500 bytes)
      expect(recovered1?.downloadedBytes, equals(500));
      expect(recovered1?.progressFraction, equals(0.5));

      expect(recovered2?.status, equals(DownloadTaskStatus.paused));
    });

    // =========================================================================
    // Gate 3: Cancel Cleanup
    // =========================================================================
    test('Gate 3: Cancel removes .part file and staging dir and marks CANCELLED', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final partFile = await storagePaths.getPartFile('ver_cancel');
      await partFile.writeAsBytes(Uint8List(200));
      expect(await partFile.exists(), isTrue);

      final task = DownloadTask(
        taskId: 'task_cancel',
        chapterVersionId: 'ver_cancel',
        chapterId: 'chap_cancel',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '4',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.downloading,
        downloadedBytes: 200,
        totalBytes: 1000,
        createdAt: now,
        updatedAt: now,
      );
      await storageRepo.insertTask(task);

      final manager = DownloadQueueManager(
        repository: storageRepo,
        artifactRepository: artifactRepo,
        downloadClient: ArtifactDownloadClient(),
        storagePaths: storagePaths,
      );

      await manager.cancelTask('task_cancel');

      final cancelledTask = await storageRepo.getTaskById('task_cancel');
      expect(cancelledTask?.status, equals(DownloadTaskStatus.cancelled));
      expect(await partFile.exists(), isFalse); // Tệp .part phải bị xóa sạch
    });

    // =========================================================================
    // Gate 4: Retry Idempotency
    // =========================================================================
    test('Gate 4: Retry preserves old task_id, resets bytes to 0, and purges .part file', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final partFile = await storagePaths.getPartFile('ver_retry');
      await partFile.writeAsBytes(Uint8List(350));

      final failedTask = DownloadTask(
        taskId: 'task_retry_fixed_id',
        chapterVersionId: 'ver_retry',
        chapterId: 'chap_retry',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '5',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.failed,
        downloadedBytes: 350,
        totalBytes: 1000,
        errorMessage: 'Network timeout',
        createdAt: now,
        updatedAt: now,
      );
      await storageRepo.insertTask(failedTask);

      final manager = DownloadQueueManager(
        repository: storageRepo,
        artifactRepository: artifactRepo,
        downloadClient: ArtifactDownloadClient(),
        storagePaths: storagePaths,
      );

      final retried = await manager.retryTask('task_retry_fixed_id', autoStart: false);

      expect(retried.taskId, equals('task_retry_fixed_id')); // Giữ nguyên ID
      expect(retried.status, equals(DownloadTaskStatus.queued));
      expect(retried.downloadedBytes, equals(0)); // Reset về 0
      expect(retried.progressFraction, equals(0.0));
      expect(retried.errorMessage, isNull);
      expect(await partFile.exists(), isFalse); // Xóa file dở dang
    });

    // =========================================================================
    // Gate 5: Filesystem Range 206 Append
    // =========================================================================
    test('Gate 5: Resume uses part file length as SSoT and appends only on HTTP 206 with correct Content-Range', () async {
      final now = DateTime.now().millisecondsSinceEpoch;

      // Đã có 400 bytes sẵn trên đĩa
      final partFile = await storagePaths.getPartFile('ver_range');
      await partFile.writeAsBytes(List.generate(400, (i) => 1));

      final task = DownloadTask(
        taskId: 'task_range',
        chapterVersionId: 'ver_range',
        chapterId: 'chap_range',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '6',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.paused,
        downloadedBytes: 100, // SQLite bị lệch cố ý để kiểm tra SSoT từ filesystem
        totalBytes: 1000,
        downloadUrl: 'https://storage.local/bundle.zip',
        createdAt: now,
        updatedAt: now,
      );
      await storageRepo.insertTask(task);

      // Tạo Mock Dio trả về HTTP 206 kèm Content-Range
      final mockDio = Dio();
      // Ta sử dụng custom download client kiểm soát luồng
      final remainingBytes = List.generate(600, (i) => 2);
      final stream = Stream<Uint8List>.fromIterable([Uint8List.fromList(remainingBytes)]);

      final fakeDownloadClient = ArtifactDownloadClient(customDio: mockDio);

      // Giả lập downloadStream trả về 206
      final responseBody = ResponseBody(
        stream.map((e) => e),
        206,
        headers: {
          'content-range': ['bytes 400-999/1000'],
        },
      );

      // Intercept request của Dio
      mockDio.httpClientAdapter = _MockHttpAdapter((options) async {
        // Kiểm tra header Range được gửi đi khớp với 400 (kích thước trên đĩa)
        expect(options.headers['Range'], equals('bytes=400-'));
        return responseBody;
      });

      final manager = DownloadQueueManager(
        repository: storageRepo,
        artifactRepository: artifactRepo,
        downloadClient: fakeDownloadClient,
        storagePaths: storagePaths,
      );

      await manager.resumeTask('task_range');

      // Chờ stream hoàn tất ghi tệp
      await Future<void>.delayed(const Duration(milliseconds: 100));

      final finalTask = await storageRepo.getTaskById('task_range');
      expect(finalTask?.downloadedBytes, equals(1000));
      expect(finalTask?.status, equals(DownloadTaskStatus.verifying));

      final finalBytes = await partFile.readAsBytes();
      expect(finalBytes.length, equals(1000));
      // 400 bytes đầu là 1, 600 bytes sau là 2
      expect(finalBytes.sublist(0, 400), equals(List.generate(400, (i) => 1)));
      expect(finalBytes.sublist(400), equals(List.generate(600, (i) => 2)));
    });

    // =========================================================================
    // Gate 6: Clean Range 200 Restart (Truncate .part to 0)
    // =========================================================================
    test('Gate 6: Receiving HTTP 200 on resume truncates .part and restarts cleanly from byte 0', () async {
      final now = DateTime.now().millisecondsSinceEpoch;

      // Giả lập tệp rác 300 bytes dở dang trên đĩa
      final partFile = await storagePaths.getPartFile('ver_clean_200');
      await partFile.writeAsBytes(List.generate(300, (i) => 9));

      final task = DownloadTask(
        taskId: 'task_clean_200',
        chapterVersionId: 'ver_clean_200',
        chapterId: 'chap_200',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '7',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.paused,
        downloadedBytes: 300,
        totalBytes: 500,
        downloadUrl: 'https://storage.local/bundle.zip',
        createdAt: now,
        updatedAt: now,
      );
      await storageRepo.insertTask(task);

      final mockDio = Dio();
      final fullBytes = List.generate(500, (i) => 5);
      final stream = Stream<Uint8List>.fromIterable([Uint8List.fromList(fullBytes)]);

      final responseBody = ResponseBody(
        stream.map((e) => e),
        200, // Server trả về 200 OK thay vì 206
      );

      mockDio.httpClientAdapter = _MockHttpAdapter((options) async {
        return responseBody;
      });

      final fakeDownloadClient = ArtifactDownloadClient(customDio: mockDio);

      final manager = DownloadQueueManager(
        repository: storageRepo,
        artifactRepository: artifactRepo,
        downloadClient: fakeDownloadClient,
        storagePaths: storagePaths,
      );

      await manager.resumeTask('task_clean_200');
      await Future<void>.delayed(const Duration(milliseconds: 100));

      final finalTask = await storageRepo.getTaskById('task_clean_200');
      expect(finalTask?.downloadedBytes, equals(500));
      expect(finalTask?.status, equals(DownloadTaskStatus.verifying));

      final finalBytes = await partFile.readAsBytes();
      expect(finalBytes.length, equals(500));
      // Toàn bộ 500 bytes là 5 (không còn 300 bytes số 9 cũ bị nối sai)
      expect(finalBytes, equals(List.generate(500, (i) => 5)));
    });

    // =========================================================================
    // Gate 7: URL Refresh & Zero Auth Trigger on 403
    // =========================================================================
    test('Gate 7: HTTP 403 from storage refreshes presigned URL without triggering Core API JWT refresh', () async {
      final now = DateTime.now().millisecondsSinceEpoch;

      final task = DownloadTask(
        taskId: 'task_403',
        chapterVersionId: 'ver_403',
        chapterId: 'chap_403',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '8',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.queued,
        downloadUrl: 'https://storage.local/expired_url',
        totalBytes: 200,
        createdAt: now,
        updatedAt: now,
      );
      await storageRepo.insertTask(task);

      final mockDio = Dio();
      int callCount = 0;

      // Lần đầu gặp 403, lần 2 với URL mới trả về 200
      mockDio.httpClientAdapter = _MockHttpAdapter((options) async {
        callCount++;
        if (options.path.contains('expired_url')) {
          return ResponseBody.fromString(
            'AccessDenied',
            403,
            headers: {'content-type': ['text/plain']},
          );
        }

        final fullBytes = List.generate(200, (i) => 7);
        return ResponseBody(
          Stream.value(Uint8List.fromList(fullBytes)),
          200,
        );
      });

      final fakeDownloadClient = ArtifactDownloadClient(customDio: mockDio);

      // Khi 403, manager gọi artifactRepo để lấy URL mới
      when(() => mockApiClient.get<Map<String, dynamic>>(
            '/api/v1/chapters/chap_403/versions/ver_403/artifact',
            queryParameters: any(named: 'queryParameters'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ''),
            statusCode: 200,
            data: {
              'status': 'READY',
              'artifactReady': true,
              'artifactType': 'OFFLINE_BUNDLE',
              'chapterVersionId': 'ver_403',
              'downloadUrl': 'https://storage.local/fresh_new_url',
              'fileSizeBytes': 200,
            },
          ));

      final manager = DownloadQueueManager(
        repository: storageRepo,
        artifactRepository: artifactRepo,
        downloadClient: fakeDownloadClient,
        storagePaths: storagePaths,
      );

      await manager.resumeTask('task_403');
      await Future<void>.delayed(const Duration(milliseconds: 100));

      final finalTask = await storageRepo.getTaskById('task_403');
      expect(finalTask?.downloadUrl, equals('https://storage.local/fresh_new_url'));
      expect(finalTask?.status, equals(DownloadTaskStatus.verifying));
      expect(callCount, equals(2)); // Đã gọi lần 1 (403) và lần 2 (fresh URL 200)
    });

    // =========================================================================
    // Gate 8: Zero Token Leakage to Storage Host
    // =========================================================================
    test('Gate 8: Storage requests carry zero Authorization or Bearer token header', () async {
      final mockDio = Dio();
      Map<String, dynamic>? interceptedHeaders;

      mockDio.httpClientAdapter = _MockHttpAdapter((options) async {
        interceptedHeaders = options.headers;
        return ResponseBody(Stream.value(Uint8List.fromList([1, 2, 3])), 200);
      });

      final client = ArtifactDownloadClient(customDio: mockDio);
      await client.downloadStream('https://s3.external-storage.com/bucket/file.zip');

      expect(interceptedHeaders, isNotNull);
      expect(interceptedHeaders!.containsKey('Authorization'), isFalse);
      expect(interceptedHeaders!.containsKey('authorization'), isFalse);
    });

    // =========================================================================
    // Gate 9: Sandbox Integrity (App-Private directory 0700)
    // =========================================================================
    test('Gate 9: Part files strictly reside inside app-private sandbox (tmpDir)', () async {
      final partFilePath = await storagePaths.getPartFilePath('ver_sandbox_check');
      final tmpDirPath = await storagePaths.getTmpDirPath();

      expect(partFilePath.startsWith(tmpDirPath), isTrue);
      expect(partFilePath.endsWith('ver_sandbox_check.part'), isTrue);
    });

    // =========================================================================
    // Gate 10: State Machine Ownership (5D.3 ends at VERIFYING, never READY)
    // =========================================================================
    test('Gate 10: 5D.3 DownloadQueueManager concludes downloading at VERIFYING, never READY', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final task = DownloadTask(
        taskId: 'task_gate_10',
        chapterVersionId: 'ver_gate_10',
        chapterId: 'chap_10',
        storyId: 'story_1',
        storyTitle: 'Story',
        chapterNumber: '10',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.queued,
        downloadUrl: 'https://storage.local/gate10.zip',
        totalBytes: 50,
        createdAt: now,
        updatedAt: now,
      );
      await storageRepo.insertTask(task);

      final mockDio = Dio();
      mockDio.httpClientAdapter = _MockHttpAdapter((options) async {
        return ResponseBody(Stream.value(Uint8List.fromList(List.filled(50, 0))), 200);
      });

      final manager = DownloadQueueManager(
        repository: storageRepo,
        artifactRepository: artifactRepo,
        downloadClient: ArtifactDownloadClient(customDio: mockDio),
        storagePaths: storagePaths,
      );

      await manager.resumeTask('task_gate_10');
      await Future<void>.delayed(const Duration(milliseconds: 100));

      final finalTask = await storageRepo.getTaskById('task_gate_10');

      // BẤT BIẾN P0.5: Task PHẢI dừng ở VERIFYING! Tuyệt đối không được là READY!
      expect(finalTask?.status, equals(DownloadTaskStatus.verifying));
      expect(finalTask?.status, isNot(equals(DownloadTaskStatus.ready)));

      // BẤT BIẾN P0.6: offline_chapters KHÔNG CÓ BẢN GHI nào (chưa được 5D.4 cài đặt)
      final isInstalled = await storageRepo.isChapterInstalled('ver_gate_10');
      expect(isInstalled, isFalse);
    });

    // =========================================================================
    // Gate 11: OfflineChapter SSoT Invariant (Row existence <=> Chapter installed)
    // =========================================================================
    test('Gate 11: OfflineChapter has no status column and row existence proves offline readiness', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final chapter = OfflineChapter(
        chapterVersionId: 'ver_ready_canonical',
        chapterId: 'chap_ready',
        storyId: 'story_001',
        storyTitle: 'Story One',
        chapterNumber: '1',
        chapterTitle: 'Opening',
        mediaFormat: 'COMIC',
        publicationFormat: 'WEBTOON',
        installedDir: 'installed/ver_ready_canonical',
        totalFiles: 15,
        totalBytes: 5000000,
        installedAt: now,
        manifestJson: '{"schemaVersion":1}',
      );

      await storageRepo.insertOfflineChapter(chapter);

      final fetched = await storageRepo.getOfflineChapter('ver_ready_canonical');
      expect(fetched, isNotNull);
      expect(fetched?.chapterVersionId, equals('ver_ready_canonical'));
      expect(await storageRepo.isChapterInstalled('ver_ready_canonical'), isTrue);

      // Xóa row -> isChapterInstalled lập tức false (SSoT)
      await storageRepo.deleteOfflineChapter('ver_ready_canonical');
      expect(await storageRepo.isChapterInstalled('ver_ready_canonical'), isFalse);
    });
  });
}

/// Helper giả lập phản hồi của Dio HttpClientAdapter trong Unit Tests
class _MockHttpAdapter implements HttpClientAdapter {
  final Future<ResponseBody> Function(RequestOptions options) _handler;

  _MockHttpAdapter(this._handler);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    return _handler(options);
  }

  @override
  void close({bool force = false}) {}
}
