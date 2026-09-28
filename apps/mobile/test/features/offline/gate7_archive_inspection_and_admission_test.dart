import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/storage/offline_storage_paths.dart';
import 'package:omninovel_mobile/features/offline/models/download_task.dart';
import 'package:omninovel_mobile/features/offline/models/offline_chapter.dart';
import 'package:omninovel_mobile/features/offline/models/storage_policy_config.dart';
import 'package:omninovel_mobile/features/offline/repositories/offline_storage_repository.dart';
import 'package:omninovel_mobile/features/offline/services/bundle_installer.dart';
import 'package:omninovel_mobile/features/offline/services/disk_space_provider.dart';
import 'package:omninovel_mobile/features/offline/services/offline_deletion_service.dart';
import 'package:omninovel_mobile/features/offline/services/reader_lease_manager.dart';
import 'package:omninovel_mobile/features/offline/services/storage_admission_coordinator.dart';
import 'package:omninovel_mobile/features/offline/services/storage_quota_manager.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockDiskSpaceProvider extends Mock implements DiskSpaceProvider {}

Uint8List createTestZip({
  required Map<String, dynamic> manifest,
  Map<String, List<int>> files = const {},
}) {
  final Map<String, dynamic> finalManifest = Map<String, dynamic>.from(manifest);
  finalManifest.putIfAbsent('bundleType', () => 'OFFLINE_READER');

  if (!finalManifest.containsKey('files')) {
    final generatedFiles = <Map<String, dynamic>>[];
    for (final entry in files.entries) {
      final fileSha = sha256.convert(entry.value).toString();
      generatedFiles.add({
        'path': entry.key,
        'size': entry.value.length,
        'sha256': fileSha,
      });
    }
    finalManifest['files'] = generatedFiles;
  }

  final archive = Archive();
  final manifestBytes = utf8.encode(jsonEncode(finalManifest));
  archive.addFile(ArchiveFile('manifest.json', manifestBytes.length, manifestBytes));

  for (final entry in files.entries) {
    archive.addFile(ArchiveFile(entry.key, entry.value.length, entry.value));
  }

  final zipData = ZipEncoder().encode(archive);
  return Uint8List.fromList(zipData!);
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
  });

  group('Phase 5D Acceptance Gates — Gate 7 Archive Inspection & Dual Admission', () {
    late Directory tempDir;

    setUp(() async {
      tempDir = await Directory.systemTemp.createTemp('gate7_test_');
    });

    tearDown(() async {
      try {
        if (await tempDir.exists()) {
          await tempDir.delete(recursive: true);
        }
      } catch (_) {}
    });

    // =========================================================================
    // Case 7.1: Metadata Inspection (0 Staging Bytes)
    // =========================================================================
    test('Case 7.1: Central Directory inspection extracts uncompressed size and entry count with 0 staging bytes', () async {
      const versionId = 'ver_gate7_1';
      final pageContent = utf8.encode('page-gate-7-1-content-data');
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c_7_1',
        'storyId': 's_7_1',
        'chapterTitle': 'Gate 7.1 Test',
        'mediaFormat': 'COMIC',
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {
          'pages/001.webp': pageContent,
          'pages/002.webp': pageContent,
        },
      );

      final zipFile = File(p.join(tempDir.path, 'test_bundle.zip'));
      await zipFile.writeAsBytes(zipBytes);

      final stagingPath = p.join(tempDir.path, 'staging', versionId);
      final stagingDir = Directory(stagingPath);

      // Thực thi Central Directory inspection isolate
      final result = inspectArchiveMetadataIsolate(ArchiveInspectionRequest(
        zipFilePath: zipFile.path,
        maxEntries: 100,
        maxUncompressedSize: 10 * 1024 * 1024,
      ));

      // Kỳ vọng: 3 entries (manifest.json, pages/001.webp, pages/002.webp)
      expect(result.entryCount, equals(3));
      expect(result.totalUncompressedBytes, greaterThan(pageContent.length * 2));

      // BẤT BIẾN: Thư mục staging KHÔNG hề được tạo ra trên đĩa (0 staging bytes)!
      expect(await stagingDir.exists(), isFalse);
    });

    // =========================================================================
    // Case 7.2: Headroom Fail-Closed (Zero Staging Bytes on Failure)
    // =========================================================================
    test('Case 7.2: Expansion breaching min disk headroom fails closed with 0 staging bytes', () async {
      final dbPath = p.join(tempDir.path, 'gate7_2.db');
      final offlineDb = OfflineDatabase();
      await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

      const userId = 'user_gate7_2';
      final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
      await storagePaths.ensureDirectoriesExist();

      final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
      final leaseManager = ReaderLeaseManager();
      final deletionService = OfflineDeletionService(
        repository: storageRepo,
        storagePaths: storagePaths,
        readerLeaseManager: leaseManager,
      );
      final diskProvider = MockDiskSpaceProvider();

      final quotaManager = StorageQuotaManager(
        repository: storageRepo,
        storagePaths: storagePaths,
        deletionService: deletionService,
        readerLeaseManager: leaseManager,
        diskSpaceProvider: diskProvider,
        config: const StoragePolicyConfig(
          minFreeDiskHeadroomBytes: 500000000, // 500 MB Headroom
        ),
      );

      final coordinator = StorageAdmissionCoordinator(
        diskSpaceProvider: diskProvider,
        storageQuotaManager: quotaManager,
        storagePaths: storagePaths,
        config: const StoragePolicyConfig(
          minFreeDiskHeadroomBytes: 500000000, // 500 MB
        ),
      );

      final installer = BundleInstaller(
        repository: storageRepo,
        storagePaths: storagePaths,
        computeRunner: <Q, R>(cb, msg) async => await cb(msg),
        admissionCoordinator: coordinator,
      );

      const versionId = 'ver_gate7_2_fail';
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c_7_2',
        'storyId': 's_7_2',
        'chapterTitle': 'Gate 7.2 Headroom Fail',
        'mediaFormat': 'COMIC',
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {'pages/001.webp': utf8.encode('large-content')},
      );
      final realSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate7_2',
        userId: userId,
        chapterVersionId: versionId,
        chapterId: 'c_7_2',
        storyId: 's_7_2',
        storyTitle: 'Story 7.2',
        chapterNumber: '1',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha,
        createdAt: 1000,
        updatedAt: 1000,
      );
      await storageRepo.insertTask(task);

      // Giả lập Free disk = 500 MB + 10 bytes (không đủ headroom sau khi giải nén expansion)
      when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 500000010);

      // Cài đặt thất bại do không đủ headroom
      await expectLater(
        () => installer.installBundle(task),
        throwsA(isA<StorageAdmissionDeniedException>()),
      );

      // BẤT BIẾN: Thư mục staging KHÔNG tồn tại, 0 byte staging còn sót lại
      final stagingDir = await storagePaths.getStagingDir(versionId);
      expect(await stagingDir.exists(), isFalse);

      // Task bị đánh dấu FAILED
      final updatedTask = await storageRepo.getTaskById('task_gate7_2');
      expect(updatedTask?.status, equals(DownloadTaskStatus.failed));

      // Không có chapter nào được ghi nhận trong DB
      expect(await storageRepo.isChapterInstalled(versionId), isFalse);

      // Toàn bộ reservations trong RAM được giải phóng
      expect(coordinator.totalReservedDiskBytes, equals(0));
      expect(coordinator.totalReservedInstallQuotaBytes, equals(0));

      await offlineDb.close();
    });

    // =========================================================================
    // Case 7.3: Installed Quota Assisted Eviction
    // =========================================================================
    test('Case 7.3: Breaching installed quota triggers LRU eviction, re-reads usage, and commits cleanly', () async {
      final dbPath = p.join(tempDir.path, 'gate7_3.db');
      final offlineDb = OfflineDatabase();
      await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

      const userId = 'user_gate7_3';
      final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
      await storagePaths.ensureDirectoriesExist();

      final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
      final leaseManager = ReaderLeaseManager();
      final deletionService = OfflineDeletionService(
        repository: storageRepo,
        storagePaths: storagePaths,
        readerLeaseManager: leaseManager,
      );
      final diskProvider = MockDiskSpaceProvider();

      // Cấu hình: Quota tối đa = 150 KB, Headroom = 50 KB
      const policyConfig = StoragePolicyConfig(
        maxOfflineStorageBytes: 150000, // 150 KB
        minFreeDiskHeadroomBytes: 50000, // 50 KB
      );

      final quotaManager = StorageQuotaManager(
        repository: storageRepo,
        storagePaths: storagePaths,
        deletionService: deletionService,
        readerLeaseManager: leaseManager,
        diskSpaceProvider: diskProvider,
        config: policyConfig,
      );

      final coordinator = StorageAdmissionCoordinator(
        diskSpaceProvider: diskProvider,
        storageQuotaManager: quotaManager,
        storagePaths: storagePaths,
        config: policyConfig,
      );

      final installer = BundleInstaller(
        repository: storageRepo,
        storagePaths: storagePaths,
        computeRunner: <Q, R>(cb, msg) async => await cb(msg),
        admissionCoordinator: coordinator,
      );

      // Đĩa có 100 MB trống (dư dả headroom)
      when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 100000000);

      // Chèn 1 chapter cũ 100 KB vào SQLite & disk (có thể bị evict)
      const vOld = 'ver_old_100kb';
      final oldInstalledDir = await storagePaths.getInstalledDir(vOld);
      await oldInstalledDir.create(recursive: true);
      await File(p.join(oldInstalledDir.path, 'page.dat')).writeAsString('old-data');

      await storageRepo.insertOfflineChapter(const OfflineChapter(
        userId: userId,
        chapterVersionId: vOld,
        chapterId: 'c_old',
        storyId: 's1',
        storyTitle: 'S',
        chapterNumber: '1',
        chapterTitle: 'Old Chap',
        mediaFormat: 'COMIC',
        installedDir: 'installed/$vOld',
        totalFiles: 1,
        totalBytes: 100000, // 100 KB
        installedAt: 100,
        manifestJson: '{}',
      ));

      expect(await storageRepo.getTotalStorageBytes(), equals(100000));

      // Tạo bundle mới uncompressed = 80 KB.
      // Projected installed = 100 KB (cũ) + 80 KB (mới) = 180 KB > 150 KB (vượt quota 30 KB).
      const vNew = 'ver_new_80kb';
      final dummyPage80Kb = List<int>.filled(80 * 1024, 65); // 80 KB
      final manifestNew = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': vNew,
        'chapterId': 'c_new',
        'storyId': 's1',
        'chapterTitle': 'New Chap 80KB',
        'mediaFormat': 'COMIC',
      };
      final zipBytesNew = createTestZip(
        manifest: manifestNew,
        files: {'pages/001.webp': dummyPage80Kb},
      );
      final realShaNew = sha256.convert(zipBytesNew).toString();

      final partFileNew = await storagePaths.getPartFile(vNew);
      await partFileNew.writeAsBytes(zipBytesNew);

      final taskNew = DownloadTask(
        taskId: 'task_gate7_3_new',
        userId: userId,
        chapterVersionId: vNew,
        chapterId: 'c_new',
        storyId: 's1',
        storyTitle: 'S',
        chapterNumber: '2',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realShaNew,
        createdAt: 2000,
        updatedAt: 2000,
      );
      await storageRepo.insertTask(taskNew);

      // Cài đặt bundle mới: Sẽ tự động evict chapter cũ để giải phóng quota
      final installedChapter = await installer.installBundle(taskNew);

      expect(installedChapter.chapterVersionId, equals(vNew));
      // Chapter cũ đã bị xóa sạch khỏi DB và disk
      expect(await storageRepo.isChapterInstalled(vOld), isFalse);
      expect(await oldInstalledDir.exists(), isFalse);

      // Chapter mới đã được cài đặt thành công
      expect(await storageRepo.isChapterInstalled(vNew), isTrue);

      // Dung lượng cài đặt hiện tại nằm dưới hạn mức 150 KB
      final currentTotal = await storageRepo.getTotalStorageBytes();
      expect(currentTotal, lessThanOrEqualTo(policyConfig.maxOfflineStorageBytes!));

      // Sổ cái reservations đã giải phóng hoàn toàn sau khi commit
      expect(coordinator.totalReservedInstallQuotaBytes, equals(0));
      expect(coordinator.totalReservedDiskBytes, equals(0));

      await offlineDb.close();
    });

    // =========================================================================
    // Case 7.4: Concurrent Extraction Overcommit Protection
    // =========================================================================
    test('Case 7.4: Concurrent extraction ledger prevents overcommitting shared physical headroom', () async {
      final dbPath = p.join(tempDir.path, 'gate7_4.db');
      final offlineDb = OfflineDatabase();
      await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

      const userId = 'user_gate7_4';
      final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
      await storagePaths.ensureDirectoriesExist();

      final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
      final leaseManager = ReaderLeaseManager();
      final deletionService = OfflineDeletionService(
        repository: storageRepo,
        storagePaths: storagePaths,
        readerLeaseManager: leaseManager,
      );
      final diskProvider = MockDiskSpaceProvider();

      const policyConfig = StoragePolicyConfig(
        minFreeDiskHeadroomBytes: 500000000, // 500 MB Headroom
      );

      final quotaManager = StorageQuotaManager(
        repository: storageRepo,
        storagePaths: storagePaths,
        deletionService: deletionService,
        readerLeaseManager: leaseManager,
        diskSpaceProvider: diskProvider,
        config: policyConfig,
      );

      final coordinator = StorageAdmissionCoordinator(
        diskSpaceProvider: diskProvider,
        storageQuotaManager: quotaManager,
        storagePaths: storagePaths,
        config: policyConfig,
      );

      // Free disk = 800 MB -> Dung lượng khả dụng cho expansion = 800 - 500 = 300 MB
      when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 800000000);

      // Installer A xin 200 MB expansion -> ĐỦ (còn lại 100 MB khả dụng)
      final tokenA = await coordinator.admitInstallation(
        taskId: 'task_installer_A',
        chapterVersionId: 'ver_A',
        uncompressedExpansionBytes: 200000000,
      );
      expect(tokenA.reservedExtractionBytes, equals(200000000));
      expect(coordinator.totalReservedExtractionBytes, equals(200000000));
      expect(coordinator.totalReservedDiskBytes, equals(200000000));

      // Installer B đồng thời xin 200 MB expansion -> BỊ TỪ CHỐI FAIL-CLOSED!
      // Vì effective free = 800 - 200 (A) = 600 MB. 600 - 200 (B) = 400 MB < 500 MB headroom!
      await expectLater(
        () => coordinator.admitInstallation(
          taskId: 'task_installer_B',
          chapterVersionId: 'ver_B',
          uncompressedExpansionBytes: 200000000,
        ),
        throwsA(isA<StorageAdmissionDeniedException>()),
      );

      // Installer A hoàn tất extraction vào staging -> update remaining extraction về 0
      coordinator.updateRemainingExtractionReservation('task_installer_A', 0);
      expect(coordinator.totalReservedExtractionBytes, equals(0));

      // Installer A commit DB xong -> release toàn bộ
      coordinator.releaseReservation('task_installer_A');
      expect(coordinator.hasReservation('task_installer_A'), isFalse);

      // Bây giờ Installer B thử lại -> THÀNH CÔNG!
      final tokenB = await coordinator.admitInstallation(
        taskId: 'task_installer_B',
        chapterVersionId: 'ver_B',
        uncompressedExpansionBytes: 200000000,
      );
      expect(tokenB.reservedExtractionBytes, equals(200000000));
      coordinator.releaseReservation('task_installer_B');

      await offlineDb.close();
    });

    // =========================================================================
    // Case 7.5: Reservation Lifecycle & Remaining-Unmaterialized Accounting
    // =========================================================================
    test('Case 7.5: Reservation lifecycle updates remaining unmaterialized bytes and avoids double-counting', () async {
      final dbPath = p.join(tempDir.path, 'gate7_5.db');
      final offlineDb = OfflineDatabase();
      await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

      const userId = 'user_gate7_5';
      final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
      await storagePaths.ensureDirectoriesExist();

      final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
      final leaseManager = ReaderLeaseManager();
      final deletionService = OfflineDeletionService(
        repository: storageRepo,
        storagePaths: storagePaths,
        readerLeaseManager: leaseManager,
      );
      final diskProvider = MockDiskSpaceProvider();

      final quotaManager = StorageQuotaManager(
        repository: storageRepo,
        storagePaths: storagePaths,
        deletionService: deletionService,
        readerLeaseManager: leaseManager,
        diskSpaceProvider: diskProvider,
        config: const StoragePolicyConfig(
          minFreeDiskHeadroomBytes: 500000000,
        ),
      );

      final coordinator = StorageAdmissionCoordinator(
        diskSpaceProvider: diskProvider,
        storageQuotaManager: quotaManager,
        storagePaths: storagePaths,
        config: const StoragePolicyConfig(
          minFreeDiskHeadroomBytes: 500000000,
        ),
      );

      when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 1000000000);

      // 1. Task admit 200 MB tải về
      await coordinator.admitDownload(
        taskId: 'task_lifecycle',
        chapterVersionId: 'ver_life',
        requiredBytes: 200000000,
      );
      expect(coordinator.totalReservedDownloadBytes, equals(200000000));

      // 2. Tải được 50 MB -> tiêu thụ bớt 50 MB hoặc cập nhật còn lại 150 MB
      coordinator.consumeDownloadReservation('task_lifecycle', 50000000);
      expect(coordinator.totalReservedDownloadBytes, equals(150000000));

      // 3. Tải tiếp đến khi còn 20 MB
      coordinator.updateRemainingDownloadReservation('task_lifecycle', 20000000);
      expect(coordinator.totalReservedDownloadBytes, equals(20000000));

      // 4. Hoàn tất tải: download reservation về 0
      coordinator.releaseDownloadReservation('task_lifecycle');
      expect(coordinator.totalReservedDownloadBytes, equals(0));

      // 5. Chuyển sang Gate 7 Admission (100 MB expansion)
      await coordinator.admitInstallation(
        taskId: 'task_lifecycle',
        chapterVersionId: 'ver_life',
        uncompressedExpansionBytes: 100000000,
      );
      expect(coordinator.totalReservedExtractionBytes, equals(100000000));
      expect(coordinator.totalReservedInstallQuotaBytes, equals(100000000));

      // 6. Extraction hoàn tất ghi ra đĩa staging: extraction reservation về 0
      coordinator.updateRemainingExtractionReservation('task_lifecycle', 0);
      expect(coordinator.totalReservedExtractionBytes, equals(0));
      // Install quota vẫn còn giữ chỗ trước khi commit DB
      expect(coordinator.totalReservedInstallQuotaBytes, equals(100000000));

      // 7. Commit DB thành công: release install quota reservation
      coordinator.releaseInstallQuotaReservation('task_lifecycle');
      expect(coordinator.totalReservedInstallQuotaBytes, equals(0));
      expect(coordinator.hasReservation('task_lifecycle'), isFalse);

      await offlineDb.close();
    });
  });
}
