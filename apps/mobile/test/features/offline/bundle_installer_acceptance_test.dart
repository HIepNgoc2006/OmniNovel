import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/storage/offline_storage_paths.dart';
import 'package:omninovel_mobile/features/offline/models/download_task.dart';
import 'package:omninovel_mobile/features/offline/models/offline_chapter.dart';
import 'package:omninovel_mobile/features/offline/repositories/offline_storage_repository.dart';
import 'package:omninovel_mobile/features/offline/services/bundle_installer.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

Uint8List createTestZip({
  required Map<String, dynamic> manifest,
  Map<String, List<int>> files = const {},
  List<ArchiveFile> rawEntries = const [],
  bool autoPopulateFiles = true,
}) {
  final Map<String, dynamic> finalManifest = Map<String, dynamic>.from(manifest);
  finalManifest.putIfAbsent('bundleType', () => 'OFFLINE_READER');

  if (autoPopulateFiles && !finalManifest.containsKey('files')) {
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
  } else if (autoPopulateFiles && finalManifest['files'] is List) {
    final existingList = (finalManifest['files'] as List).map((item) {
      if (item is Map<String, dynamic>) {
        final itemMap = Map<String, dynamic>.from(item);
        final path = itemMap['path'] as String?;
        if (path != null && files.containsKey(path)) {
          itemMap.putIfAbsent('sha256', () => sha256.convert(files[path]!).toString());
          itemMap.putIfAbsent('size', () => files[path]!.length);
        }
        return itemMap;
      }
      return item;
    }).toList();
    finalManifest['files'] = existingList;
  }

  final archive = Archive();

  // Thêm manifest.json
  final manifestBytes = utf8.encode(jsonEncode(finalManifest));
  archive.addFile(ArchiveFile('manifest.json', manifestBytes.length, manifestBytes));

  // Thêm các tệp dữ liệu
  for (final entry in files.entries) {
    archive.addFile(ArchiveFile(entry.key, entry.value.length, entry.value));
  }

  // Thêm raw entries tùy biến (phục vụ test Zip Slip, Symlink...)
  for (final raw in rawEntries) {
    archive.addFile(raw);
  }

  final zipData = ZipEncoder().encode(archive);
  return Uint8List.fromList(zipData!);
}

Uint8List createSymlinkZip({
  required Map<String, dynamic> manifest,
  required String symlinkPath,
  required String targetPath,
}) {
  final tempDir = Directory.systemTemp.createTempSync('sym_zip_');
  try {
    final scriptFile = File(p.join(tempDir.path, 'gen_sym.py'));
    final zipFile = File(p.join(tempDir.path, 'bundle.zip'));
    final manifestStr = jsonEncode(manifest);
    final script = '''
import zipfile
zinfo = zipfile.ZipInfo("$symlinkPath")
zinfo.create_system = 3
zinfo.external_attr = 0xA1ED0000

with zipfile.ZipFile("${zipFile.path.replaceAll('\\', '/')}", "w") as z:
    z.writestr("manifest.json", """$manifestStr""")
    z.writestr(zinfo, "$targetPath")
''';
    scriptFile.writeAsStringSync(script);
    var res = Process.runSync('python3', [scriptFile.path]);
    if (res.exitCode != 0) {
      res = Process.runSync('python', [scriptFile.path]);
    }
    if (!zipFile.existsSync()) {
      throw Exception('Không thể tạo symlink zip qua python: ${res.stderr}');
    }
    return zipFile.readAsBytesSync();
  } finally {
    tempDir.deleteSync(recursive: true);
  }
}

Uint8List createDuplicateZip({
  required Map<String, dynamic> manifest,
  required String duplicatePath,
}) {
  final tempDir = Directory.systemTemp.createTempSync('dup_zip_');
  try {
    final scriptFile = File(p.join(tempDir.path, 'gen_dup.py'));
    final zipFile = File(p.join(tempDir.path, 'bundle.zip'));
    final manifestStr = jsonEncode(manifest);
    final script = '''
import zipfile
with zipfile.ZipFile("${zipFile.path.replaceAll('\\', '/')}", "w") as z:
    z.writestr("manifest.json", """$manifestStr""")
    z.writestr("$duplicatePath", "dup-content-1")
    z.writestr("$duplicatePath", "dup-content-2")
''';
    scriptFile.writeAsStringSync(script);
    var res = Process.runSync('python3', [scriptFile.path]);
    if (res.exitCode != 0) {
      res = Process.runSync('python', [scriptFile.path]);
    }
    if (!zipFile.existsSync()) {
      throw Exception('Không thể tạo duplicate zip qua python: ${res.stderr}');
    }
    return zipFile.readAsBytesSync();
  } finally {
    tempDir.deleteSync(recursive: true);
  }
}

void main() {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  late Directory tempDir;
  late OfflineDatabase offlineDb;
  late OfflineStorageRepository storageRepo;
  late OfflineStoragePaths storagePaths;
  late BundleInstaller bundleInstaller;

  setUp(() async {
    tempDir = Directory.systemTemp.createTempSync('omninovel_bundle_installer_test_');

    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: inMemoryDatabasePath,
      databaseFactory: databaseFactoryFfi,
    );

    storageRepo = OfflineStorageRepository(database: offlineDb);
    storagePaths = OfflineStoragePaths(customBasePath: tempDir.path);
    await storagePaths.ensureDirectoriesExist();

    // Dùng computeRunner đồng bộ trong môi trường test ffi để deterministic
    bundleInstaller = BundleInstaller(
      repository: storageRepo,
      storagePaths: storagePaths,
      computeRunner: <Q, R>(callback, message) async => await callback(message),
    );
  });

  tearDown(() async {
    await offlineDb.close();
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  group('Phase 5D.4 Acceptance Gates — Offline Bundle Installation & Bidirectional Reconciliation', () {
    // =========================================================================
    // Gate 1: SHA-256 Fail-Closed
    // =========================================================================
    test('Gate 1: SHA-256 mismatch rejects extraction, fails task, zero offline_chapters row', () async {
      const versionId = 'v1_gate1';
      final manifest = {
        'schemaVersion': 1,
        'chapterVersionId': versionId,
        'chapterId': 'c1',
        'storyId': 's1',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': 12}
        ]
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {'pages/001.webp': utf8.encode('dummy-image-')},
      );

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      const task = DownloadTask(
        taskId: 'task_gate1',
        chapterVersionId: versionId,
        chapterId: 'c1',
        storyId: 's1',
        storyTitle: 'Test Story',
        chapterNumber: '1',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: 'wrong_sha256_hash_that_definitely_does_not_match',
        createdAt: 1000,
        updatedAt: 1000,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<ChecksumMismatchException>()),
      );

      // Verify task status chuyển FAILED
      final updatedTask = await storageRepo.getTaskById('task_gate1');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('Mã băm SHA-256 không khớp'));

      // Verify zero offline_chapters row
      final installed = await storageRepo.getOfflineChapter(versionId);
      expect(installed, isNull);

      // Verify staging dọn sạch
      final stagingPath = await storagePaths.getStagingPathForVersion(versionId);
      expect(Directory(stagingPath).existsSync(), isFalse);
    });

    // =========================================================================
    // Gate 2: Exact Version Manifest Binding
    // =========================================================================
    test('Gate 2: Manifest chapterVersionId mismatch or invalid schema fails closed', () async {
      const versionId = 'v2_gate2';
      final manifest = {
        'schemaVersion': 1,
        'chapterVersionId': 'different_version_id_mismatch',
        'chapterId': 'c2',
        'storyId': 's2',
        'mediaFormat': 'COMIC',
        'files': <Map<String, dynamic>>[],
      };
      final zipBytes = createTestZip(manifest: manifest);
      final realSha256 = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate2',
        chapterVersionId: versionId,
        chapterId: 'c2',
        storyId: 's2',
        storyTitle: 'Test Story 2',
        chapterNumber: '2',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 2000,
        updatedAt: 2000,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<ManifestValidationException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate2');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('Sai lệch chapterVersionId trong manifest'));

      expect(await storageRepo.getOfflineChapter(versionId), isNull);
    });

    // =========================================================================
    // Gate 3: Safe Extraction (Zip Slip & Path Traversal Mitigation)
    // =========================================================================
    test('Gate 3: Zip Slip path traversal attempt is blocked and fails closed', () async {
      const versionId = 'v3_gate3';
      final maliciousEntry = ArchiveFile(
        '../../evil.txt',
        9,
        utf8.encode('malicious'),
      );
      final manifest = {
        'schemaVersion': 1,
        'chapterVersionId': versionId,
        'chapterId': 'c3',
        'storyId': 's3',
        'mediaFormat': 'COMIC',
        'files': <Map<String, dynamic>>[],
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        rawEntries: [maliciousEntry],
      );
      final realSha256 = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate3',
        chapterVersionId: versionId,
        chapterId: 'c3',
        storyId: 's3',
        storyTitle: 'Test Story 3',
        chapterNumber: '3',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 3000,
        updatedAt: 3000,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<ZipSlipException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate3');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('Zip Slip'));

      expect(await storageRepo.getOfflineChapter(versionId), isNull);
    });

    test('Gate 3b: Malformed zip archive is rejected fail-closed', () async {
      const versionId = 'v3b_gate3b';
      final corruptBytes = Uint8List.fromList([0x12, 0x34, 0x56, 0x78, 0x90]);
      final realSha256 = sha256.convert(corruptBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(corruptBytes);

      final task = DownloadTask(
        taskId: 'task_gate3b',
        chapterVersionId: versionId,
        chapterId: 'c3b',
        storyId: 's3b',
        storyTitle: 'Test Story 3b',
        chapterNumber: '3b',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 3500,
        updatedAt: 3500,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<UnsafeArchiveException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate3b');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
    });

    // =========================================================================
    // Gate 4: Bounded Extraction (Zip Bomb Mitigation)
    // =========================================================================
    test('Gate 4: Archive exceeding max entries limit is rejected with ZipBombException', () async {
      const versionId = 'v4_gate4';
      final manifest = {
        'schemaVersion': 1,
        'chapterVersionId': versionId,
        'chapterId': 'c4',
        'storyId': 's4',
        'mediaFormat': 'COMIC',
        'files': <Map<String, dynamic>>[],
      };

      // Custom installer với maxEntries = 5 để test nhanh
      final customInstaller = BundleInstaller(
        repository: storageRepo,
        storagePaths: storagePaths,
        computeRunner: <Q, R>(callback, message) async {
          if (message is SafeExtractionRequest) {
            return await callback(SafeExtractionRequest(
              zipFilePath: message.zipFilePath,
              stagingDirPath: message.stagingDirPath,
              maxEntries: 3, // Giới hạn chỉ 3 entries
            ) as Q);
          }
          return await callback(message);
        },
      );

      final files = {
        'f1.txt': [1],
        'f2.txt': [2],
        'f3.txt': [3],
        'f4.txt': [4],
      }; // 4 files + 1 manifest = 5 entries > 3
      final zipBytes = createTestZip(manifest: manifest, files: files);
      final realSha256 = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate4',
        chapterVersionId: versionId,
        chapterId: 'c4',
        storyId: 's4',
        storyTitle: 'Test Story 4',
        chapterNumber: '4',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 4000,
        updatedAt: 4000,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        customInstaller.installBundle(task),
        throwsA(isA<ZipBombException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate4');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('Vượt quá số lượng tệp tối đa'));
    });

    // =========================================================================
    // Gate 5 & Gate 6 & Gate 7: Staging Isolation, Atomic Promotion & READY SSoT
    // =========================================================================
    test('Gate 5, 6, 7: Staging is isolated, atomic promotion commits to installed, offline_chapters created, READY status', () async {
      const versionId = 'v5_gate567';
      final pageContent = utf8.encode('image-payload-webp-12345');
      final manifest = {
        'schemaVersion': 1,
        'chapterVersionId': versionId,
        'chapterId': 'c5',
        'storyId': 's5',
        'chapterTitle': 'Đại Náo Thiên Cung',
        'mediaFormat': 'COMIC',
        'publicationFormat': 'WEBTOON',
        'files': [
          {'path': 'pages/001.webp', 'size': pageContent.length}
        ]
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {'pages/001.webp': pageContent},
      );
      final realSha256 = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate567',
        chapterVersionId: versionId,
        chapterId: 'c5',
        storyId: 's5',
        storyTitle: 'Tây Du Ký',
        chapterNumber: '5',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 5000,
        updatedAt: 5000,
      );
      await storageRepo.insertTask(task);

      // Trước khi install: installed/ không có gì
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      expect(Directory(installedPath).existsSync(), isFalse);

      // Thực thi cài đặt
      final offlineChapter = await bundleInstaller.installBundle(task);
      expect(offlineChapter.chapterVersionId, versionId);

      // Gate 5 & Gate 6: Staging đã được xóa, installed/ chứa đầy đủ tệp
      final stagingPath = await storagePaths.getStagingPathForVersion(versionId);
      expect(Directory(stagingPath).existsSync(), isFalse);
      expect(Directory(installedPath).existsSync(), isTrue);
      expect(File(p.join(installedPath, 'manifest.json')).existsSync(), isTrue);
      expect(File(p.join(installedPath, 'pages/001.webp')).existsSync(), isTrue);

      // Gate 7: Canonical READY SSoT (row trong offline_chapters + task READY)
      final dbChapter = await storageRepo.getOfflineChapter(versionId);
      expect(dbChapter, isNotNull);
      expect(dbChapter?.chapterTitle, 'Đại Náo Thiên Cung');
      expect(dbChapter?.chapterVersionId, versionId);

      final updatedTask = await storageRepo.getTaskById('task_gate567');
      expect(updatedTask?.status, DownloadTaskStatus.ready);

      // .part file đã được dọn sạch
      expect(partFile.existsSync(), isFalse);
    });

    // =========================================================================
    // Gate 8: Crash Before Promotion (Staging Orphan Cleaned)
    // =========================================================================
    test('Gate 8: Staging orphan leftover from crash before promotion is cleaned on startup', () async {
      // Giả lập crash: để lại thư mục staging dở dang
      final orphanStagingPath = await storagePaths.getStagingPathForVersion('orphan_v8');
      final orphanDir = Directory(orphanStagingPath);
      orphanDir.createSync(recursive: true);
      File(p.join(orphanStagingPath, 'half_extracted.tmp')).writeAsStringSync('crash');

      expect(orphanDir.existsSync(), isTrue);

      // App bật lại và chạy startup reconciliation
      final report = await bundleInstaller.reconcileOnStartup();

      expect(report.cleanedStagingDirs, greaterThanOrEqualTo(1));
      expect(orphanDir.existsSync(), isFalse);
    });

    // =========================================================================
    // Gate 9: Crash After Promotion / Before DB Commit (Deterministic Reconstruct)
    // =========================================================================
    test('Gate 9: Crash after promotion before DB commit reconciles by reconstructing row and setting READY', () async {
      const versionId = 'v9_crash_after_promo';
      final pageContent = utf8.encode('page-content-999');
      final pageSha = sha256.convert(pageContent).toString();
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c9',
        'storyId': 's9',
        'chapterTitle': 'Phục hồi sau Crash',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': pageContent.length, 'sha256': pageSha}
        ]
      };

      // Đặt thư mục vào installed/ nhưng CHƯA ghi vào DB offline_chapters
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      final installedDir = Directory(installedPath);
      installedDir.createSync(recursive: true);
      File(p.join(installedPath, 'manifest.json')).writeAsStringSync(jsonEncode(manifest));
      final pageFile = File(p.join(installedPath, 'pages/001.webp'));
      pageFile.parent.createSync(recursive: true);
      pageFile.writeAsBytesSync(pageContent);

      // Có task đang ở trạng thái verifying
      const task = DownloadTask(
        taskId: 'task_gate9',
        chapterVersionId: versionId,
        chapterId: 'c9',
        storyId: 's9',
        storyTitle: 'Tây Du Ký',
        chapterNumber: '9',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        createdAt: 9000,
        updatedAt: 9000,
      );
      await storageRepo.insertTask(task);

      // DB row offline_chapters chưa tồn tại
      expect(await storageRepo.isChapterInstalled(versionId), isFalse);

      // App bật lại: startup reconciliation
      final report = await bundleInstaller.reconcileOnStartup();

      expect(report.reconstructedRows, 1);

      // DB row đã được tái tạo thành công
      final chapter = await storageRepo.getOfflineChapter(versionId);
      expect(chapter, isNotNull);
      expect(chapter?.chapterTitle, 'Phục hồi sau Crash');

      // Task được đồng bộ sang READY
      final updatedTask = await storageRepo.getTaskById('task_gate9');
      expect(updatedTask?.status, DownloadTaskStatus.ready);
    });

    // =========================================================================
    // Gate 10: DB Row / Missing Files (Stale Row Pruning)
    // =========================================================================
    test('Gate 10: DB row exists but installed payload is missing -> pruned fail-closed', () async {
      const versionId = 'v10_missing_files';
      const offlineChapter = OfflineChapter(
        chapterVersionId: versionId,
        chapterId: 'c10',
        storyId: 's10',
        storyTitle: 'Story 10',
        chapterNumber: '10',
        mediaFormat: 'COMIC',
        installedDir: 'installed/$versionId',
        totalFiles: 2,
        totalBytes: 5000,
        installedAt: 10000,
        manifestJson: '{}',
      );
      await storageRepo.insertOfflineChapter(offlineChapter);

      const task = DownloadTask(
        taskId: 'task_gate10',
        chapterVersionId: versionId,
        chapterId: 'c10',
        storyId: 's10',
        storyTitle: 'Story 10',
        chapterNumber: '10',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.ready,
        createdAt: 10000,
        updatedAt: 10000,
      );
      await storageRepo.insertTask(task);

      // Files trên đĩa hoàn toàn KHÔNG tồn tại
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      expect(Directory(installedPath).existsSync(), isFalse);

      final report = await bundleInstaller.reconcileOnStartup();

      expect(report.removedCorruptedRows, 1);
      // DB row bị xóa sạch
      expect(await storageRepo.isChapterInstalled(versionId), isFalse);

      // Task bị chuyển sang FAILED
      final updatedTask = await storageRepo.getTaskById('task_gate10');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('bị mất hoặc hỏng'));
    });

    // =========================================================================
    // Gate 11: Orphan Installed Directory
    // =========================================================================
    test('Gate 11: Orphan installed directory with no task or corrupted files is safely removed', () async {
      const versionId = 'v11_orphan_dir';
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      final dir = Directory(installedPath);
      dir.createSync(recursive: true);
      File(p.join(installedPath, 'corrupted_random.dat')).writeAsStringSync('garbage');

      // Không có DB row, không có task
      expect(dir.existsSync(), isTrue);

      final report = await bundleInstaller.reconcileOnStartup();

      expect(report.removedOrphanDirs, 1);
      expect(dir.existsSync(), isFalse);
    });

    // =========================================================================
    // Gate 12: Installer Idempotency
    // =========================================================================
    test('Gate 12: Calling installBundle multiple times for same version is safe and idempotent', () async {
      const versionId = 'v12_idempotent';
      final manifest = {
        'schemaVersion': 1,
        'chapterVersionId': versionId,
        'chapterId': 'c12',
        'storyId': 's12',
        'chapterTitle': 'Idempotent Test',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': 5}
        ]
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {'pages/001.webp': [1, 2, 3, 4, 5]},
      );
      final realSha256 = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate12',
        chapterVersionId: versionId,
        chapterId: 'c12',
        storyId: 's12',
        storyTitle: 'Story 12',
        chapterNumber: '12',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 12000,
        updatedAt: 12000,
      );
      await storageRepo.insertTask(task);

      // Lần gọi 1: Cài đặt thành công
      final chapter1 = await bundleInstaller.installBundle(task);
      expect(chapter1.chapterVersionId, versionId);

      // Lần gọi 2: Idempotent return chapter hiện có
      final chapter2 = await bundleInstaller.installBundle(task);
      expect(chapter2.chapterVersionId, versionId);
      expect(chapter2.chapterTitle, chapter1.chapterTitle);

      // Không sinh duplicate records trong SQLite
      final chapters = await storageRepo.getOfflineChaptersByStory('s12');
      expect(chapters.length, 1);
    });

    // =========================================================================
    // Gate 13: Dangling .part Cleanup
    // =========================================================================
    test('Gate 13: Dangling .part file for an already installed chapter is cleaned by reconciliation', () async {
      const versionId = 'v13_cleanup';
      final pageContent = utf8.encode('dummy-page-13');
      final pageSha = sha256.convert(pageContent).toString();
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c13',
        'storyId': 's13',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': pageContent.length, 'sha256': pageSha}
        ],
      };
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      Directory(installedPath).createSync(recursive: true);
      final pageFile = File(p.join(installedPath, 'pages/001.webp'));
      pageFile.parent.createSync(recursive: true);
      pageFile.writeAsBytesSync(pageContent);
      File(p.join(installedPath, 'manifest.json')).writeAsStringSync(jsonEncode(manifest));

      final offlineChapter = OfflineChapter(
        chapterVersionId: versionId,
        chapterId: 'c13',
        storyId: 's13',
        storyTitle: 'Story 13',
        chapterNumber: '13',
        mediaFormat: 'COMIC',
        installedDir: 'installed/$versionId',
        totalFiles: 1,
        totalBytes: pageContent.length,
        installedAt: 13000,
        manifestJson: jsonEncode(manifest),
      );
      await storageRepo.insertOfflineChapter(offlineChapter);

      // Tạo tệp .part còn sót
      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsString('dangling part bytes');
      expect(partFile.existsSync(), isTrue);

      final report = await bundleInstaller.reconcileOnStartup();

      expect(report.cleanedPartFiles, 1);
      expect(partFile.existsSync(), isFalse);
    });

    // =========================================================================
    // Gate 14: Novel Content Resolution (content.html Verification)
    // =========================================================================
    test('Gate 14: Novel bundle verifies content.html and binds novelMetadata', () async {
      const versionId = 'v14_novel';
      final novelHtml = utf8.encode('<p>Chương 1: Khởi đầu mới</p>');
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c14',
        'storyId': 's14',
        'chapterTitle': 'Chương 1: Khởi đầu mới',
        'mediaFormat': 'NOVEL',
        'novelMetadata': {'contentPath': 'content.html'},
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {'content.html': novelHtml},
      );
      final realSha256 = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate14',
        chapterVersionId: versionId,
        chapterId: 'c14',
        storyId: 's14',
        storyTitle: 'Tiểu thuyết Kiếm Hiệp',
        chapterNumber: '1',
        mediaFormat: 'NOVEL',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 14000,
        updatedAt: 14000,
      );
      await storageRepo.insertTask(task);

      final offlineChapter = await bundleInstaller.installBundle(task);

      expect(offlineChapter.mediaFormat, 'NOVEL');
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      expect(File(p.join(installedPath, 'content.html')).existsSync(), isTrue);
    });

    // =========================================================================
    // Gate 15: State Ownership Enforcement
    // =========================================================================
    test('Gate 15: State transition VERIFYING -> READY occurs exclusively via BundleInstaller', () async {
      const versionId = 'v15_ownership';
      final pageContent = utf8.encode('ownership page');
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c15',
        'storyId': 's15',
        'mediaFormat': 'COMIC',
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {'pages/001.webp': pageContent},
      );
      final realSha256 = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate15',
        chapterVersionId: versionId,
        chapterId: 'c15',
        storyId: 's15',
        storyTitle: 'Ownership Test',
        chapterNumber: '15',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 15000,
        updatedAt: 15000,
      );
      await storageRepo.insertTask(task);

      // Verify task đang ở VERIFYING
      var current = await storageRepo.getTaskById('task_gate15');
      expect(current?.status, DownloadTaskStatus.verifying);

      // Chỉ khi BundleInstaller hoàn tất cài đặt thành công thì mới sang READY
      await bundleInstaller.installBundle(task);

      current = await storageRepo.getTaskById('task_gate15');
      expect(current?.status, DownloadTaskStatus.ready);
    });

    // =========================================================================
    // Gate 3c: Symlink Rejection Fail-Closed
    // =========================================================================
    test('Gate 3c: Symlink entry in zip archive is rejected fail-closed with UnsafeArchiveException', () async {
      const versionId = 'v3c_symlink';
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c3c',
        'storyId': 's3c',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/symlink.webp', 'size': 11, 'sha256': 'dummy'}
        ],
      };
      final zipBytes = createSymlinkZip(
        manifest: manifest,
        symlinkPath: 'pages/symlink.webp',
        targetPath: '/etc/passwd',
      );
      final realSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate3c',
        chapterVersionId: versionId,
        chapterId: 'c3c',
        storyId: 's3c',
        storyTitle: 'Symlink Story',
        chapterNumber: '3c',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha,
        createdAt: 3300,
        updatedAt: 3300,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<UnsafeArchiveException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate3c');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('symlink/hardlink'));
    });

    // =========================================================================
    // Gate 3d: Duplicate Paths Rejection
    // =========================================================================
    test('Gate 3d: Duplicate paths in zip archive is rejected with UnsafeArchiveException', () async {
      const versionId = 'v3d_duplicate';
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c3d',
        'storyId': 's3d',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': 13, 'sha256': 'dummy'}
        ],
      };
      final zipBytes = createDuplicateZip(
        manifest: manifest,
        duplicatePath: 'pages/001.webp',
      );
      final realSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate3d',
        chapterVersionId: versionId,
        chapterId: 'c3d',
        storyId: 's3d',
        storyTitle: 'Duplicate Path Story',
        chapterNumber: '3d',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha,
        createdAt: 3400,
        updatedAt: 3400,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<UnsafeArchiveException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate3d');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('đường dẫn trùng lặp'));
    });

    // =========================================================================
    // Gate 9b: Crash After offline_chapters Insert / Before Task READY Normalization
    // =========================================================================
    test('Gate 9b: Crash after offline_chapters insert / before READY commits normalizes PAUSED task to READY on startup', () async {
      const versionId = 'v9b_crash_before_ready';
      final pageContent = utf8.encode('page-content-9b');
      final pageSha = sha256.convert(pageContent).toString();
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c9b',
        'storyId': 's9b',
        'chapterTitle': 'Crash Before Ready',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': pageContent.length, 'sha256': pageSha}
        ]
      };
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      final installedDir = Directory(installedPath);
      installedDir.createSync(recursive: true);
      File(p.join(installedPath, 'manifest.json')).writeAsStringSync(jsonEncode(manifest));
      final pageFile = File(p.join(installedPath, 'pages/001.webp'));
      pageFile.parent.createSync(recursive: true);
      pageFile.writeAsBytesSync(pageContent);

      final chapter = OfflineChapter(
        chapterVersionId: versionId,
        chapterId: 'c9b',
        storyId: 's9b',
        storyTitle: 'Story 9b',
        chapterNumber: '9b',
        chapterTitle: 'Crash Before Ready',
        mediaFormat: 'COMIC',
        installedDir: 'installed/$versionId',
        totalFiles: 1,
        totalBytes: pageContent.length,
        installedAt: 9500,
        manifestJson: jsonEncode(manifest),
      );
      await storageRepo.insertOfflineChapter(chapter);

      const task = DownloadTask(
        taskId: 'task_gate9b',
        chapterVersionId: versionId,
        chapterId: 'c9b',
        storyId: 's9b',
        storyTitle: 'Story 9b',
        chapterNumber: '9b',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.paused,
        createdAt: 9500,
        updatedAt: 9500,
      );
      await storageRepo.insertTask(task);

      await bundleInstaller.reconcileOnStartup();

      final updatedTask = await storageRepo.getTaskById('task_gate9b');
      expect(updatedTask?.status, DownloadTaskStatus.ready);
    });

    // =========================================================================
    // Gate 12b: Idempotency Rejects Damaged Install and Forces Clean Reinstall
    // =========================================================================
    test('Gate 12b: Idempotency check detects deleted page and returns null, forcing re-installation', () async {
      const versionId = 'v12b_deleted_page';
      final pageContent = utf8.encode('page-12b');
      final pageSha = sha256.convert(pageContent).toString();
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c12b',
        'storyId': 's12b',
        'chapterTitle': 'Damaged Payload Test',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': pageContent.length, 'sha256': pageSha}
        ]
      };
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      final installedDir = Directory(installedPath);
      installedDir.createSync(recursive: true);
      File(p.join(installedPath, 'manifest.json')).writeAsStringSync(jsonEncode(manifest));
      final pageFile = File(p.join(installedPath, 'pages/001.webp'));
      pageFile.parent.createSync(recursive: true);
      pageFile.writeAsBytesSync(pageContent);

      final chapter = OfflineChapter(
        chapterVersionId: versionId,
        chapterId: 'c12b',
        storyId: 's12b',
        storyTitle: 'Story 12b',
        chapterNumber: '12b',
        chapterTitle: 'Damaged Payload Test',
        mediaFormat: 'COMIC',
        installedDir: 'installed/$versionId',
        totalFiles: 1,
        totalBytes: pageContent.length,
        installedAt: 12500,
        manifestJson: jsonEncode(manifest),
      );
      await storageRepo.insertOfflineChapter(chapter);

      // Ban đầu hợp lệ
      expect(await bundleInstaller.isAlreadyInstalledAndValid(versionId), isNotNull);

      // File bị xóa sau đó
      pageFile.deleteSync();
      expect(pageFile.existsSync(), isFalse);

      // Idempotency check bắt buộc trả về null (fail-closed)
      final validChapter = await bundleInstaller.isAlreadyInstalledAndValid(versionId);
      expect(validChapter, isNull);
    });

    // =========================================================================
    // Gate 14b: Background Extraction Offloaded to ComputeRunner
    // =========================================================================
    test('Gate 14b: Background Extraction offloads SHA-256 and unzipping to ComputeRunner isolate', () async {
      const versionId = 'v14b_isolate';
      final pageContent = utf8.encode('page-14b');
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c14b',
        'storyId': 's14b',
        'chapterTitle': 'Isolate Test',
        'mediaFormat': 'COMIC',
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {'pages/001.webp': pageContent},
      );
      final realSha256 = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate14b',
        chapterVersionId: versionId,
        chapterId: 'c14b',
        storyId: 's14b',
        storyTitle: 'Isolate Story',
        chapterNumber: '14b',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha256,
        createdAt: 14500,
        updatedAt: 14500,
      );
      await storageRepo.insertTask(task);

      final computeCalls = <String>[];
      final monitoredInstaller = BundleInstaller(
        repository: storageRepo,
        storagePaths: storagePaths,
        computeRunner: <Q, R>(callback, message) async {
          if (message is String) {
            computeCalls.add('computeFileSha256Isolate');
          } else if (message is SafeExtractionRequest) {
            computeCalls.add('safeExtractArchiveIsolate');
          }
          return await callback(message);
        },
      );

      await monitoredInstaller.installBundle(task);

      // Chứng minh cả SHA-256 lẫn extraction đều được ủy quyền cho ComputeRunner
      expect(computeCalls, contains('computeFileSha256Isolate'));
      expect(computeCalls, contains('safeExtractArchiveIsolate'));
      expect(computeCalls.length, 2);
    });

    // =========================================================================
    // Gate 17a: Cancellation During Installation Aborts Safely
    // =========================================================================
    test('Gate 17a: Cancel during installBundle aborts before promotion and cleans staging without setting FAILED', () async {
      const versionId = 'v17a_cancel';
      final pageContent = utf8.encode('page-17a');
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c17a',
        'storyId': 's17a',
        'mediaFormat': 'COMIC',
      };
      final zipBytes = createTestZip(manifest: manifest, files: {'pages/001.webp': pageContent});
      final realSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate17a',
        chapterVersionId: versionId,
        chapterId: 'c17a',
        storyId: 's17a',
        storyTitle: 'Cancel Test',
        chapterNumber: '17a',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha,
        createdAt: 17000,
        updatedAt: 17000,
      );
      await storageRepo.insertTask(task);

      final cancelToken = CancelToken();

      // Giả lập hủy token trong lúc compute runner đang giải nén
      final cancellableInstaller = BundleInstaller(
        repository: storageRepo,
        storagePaths: storagePaths,
        computeRunner: <Q, R>(callback, message) async {
          final res = await callback(message);
          if (message is SafeExtractionRequest) {
            cancelToken.cancel('User cancelled download');
          }
          return res;
        },
      );

      await expectLater(
        cancellableInstaller.installBundle(task, cancelToken: cancelToken),
        throwsA(isA<OfflineInstallationCancelledException>()),
      );

      // Verify staging được dọn sạch
      final stagingPath = await storagePaths.getStagingPathForVersion(versionId);
      expect(Directory(stagingPath).existsSync(), isFalse);

      // Verify installed/ không tồn tại
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      expect(Directory(installedPath).existsSync(), isFalse);

      // Verify zero offline_chapters row
      expect(await storageRepo.isChapterInstalled(versionId), isFalse);

      // Task KHÔNG bị chuyển thành FAILED (để cancelTask ghi CANCELLED)
      final currentTask = await storageRepo.getTaskById('task_gate17a');
      expect(currentTask?.status, isNot(DownloadTaskStatus.failed));
      expect(currentTask?.status, isNot(DownloadTaskStatus.ready));
    });

    // =========================================================================
    // Gate 17b: Cancel After Promotion / Before DB Transaction (Installed Rollback)
    // =========================================================================
    test('Gate 17b: Cancel after promotion before DB transaction triggers installed rollback and prevents startup resurrection', () async {
      const versionId = 'v17b_cancel_after_promote';
      final pageContent = utf8.encode('page-content-17b');
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c17b',
        'storyId': 's17b',
        'mediaFormat': 'COMIC',
      };
      final zipBytes = createTestZip(manifest: manifest, files: {'pages/001.webp': pageContent});
      final realSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate17b',
        chapterVersionId: versionId,
        chapterId: 'c17b',
        storyId: 's17b',
        storyTitle: 'Cancel After Promote Test',
        chapterNumber: '17b',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha,
        createdAt: 17100,
        updatedAt: 17100,
      );
      await storageRepo.insertTask(task);

      final cancelToken = CancelToken();

      // Sử dụng HookedStoragePaths để cancel token ngay sau khi promotion (tại getRootOfflinePath)
      final hookedStoragePaths = _CancelAfterPromoteStoragePaths(
        customBasePath: tempDir.path,
        cancelToken: cancelToken,
      );

      final installer = BundleInstaller(
        repository: storageRepo,
        storagePaths: hookedStoragePaths,
        computeRunner: <Q, R>(callback, message) async => await callback(message),
      );

      await expectLater(
        installer.installBundle(task, cancelToken: cancelToken),
        throwsA(isA<OfflineInstallationCancelledException>()),
      );

      // Verify BẤT BIẾN: installed/ ĐÃ ĐƯỢC ROLLBACK XÓA KHỎI ĐĨA!
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      expect(Directory(installedPath).existsSync(), isFalse);

      // Staging cũng bị xóa sạch
      final stagingPath = await storagePaths.getStagingPathForVersion(versionId);
      expect(Directory(stagingPath).existsSync(), isFalse);

      // DB row chưa tồn tại
      expect(await storageRepo.isChapterInstalled(versionId), isFalse);

      // Đánh dấu task là CANCELLED (giống hành vi thực tế của queue manager)
      await storageRepo.updateTaskStatus('task_gate17b', DownloadTaskStatus.cancelled);

      // Chạy startup reconciliation để chứng minh KHÔNG CÓ resurrection
      final report = await bundleInstaller.reconcileOnStartup();
      expect(report.reconstructedRows, 0);

      final postReconcileTask = await storageRepo.getTaskById('task_gate17b');
      expect(postReconcileTask?.status, DownloadTaskStatus.cancelled);
      expect(await storageRepo.isChapterInstalled(versionId), isFalse);
    });

    // =========================================================================
    // Gate 18: File Tamper / SHA Mismatch Detection
    // =========================================================================
    test('Gate 18: File modified on disk with same size triggers SHA mismatch and fails validation', () async {
      const versionId = 'v18_tampered_file';
      final originalContent = utf8.encode('original-unaltered-content');
      final tamperedContent = utf8.encode('tampered-malicious-content'); // same byte length 26
      assert(originalContent.length == tamperedContent.length);

      final originalSha = sha256.convert(originalContent).toString();
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c18',
        'storyId': 's18',
        'chapterTitle': 'Tamper Test',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': originalContent.length, 'sha256': originalSha}
        ]
      };
      // Tệp zip chứa nội dung đã bị sửa (tampered)
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {'pages/001.webp': tamperedContent},
        autoPopulateFiles: false,
      );
      final realZipSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate18',
        chapterVersionId: versionId,
        chapterId: 'c18',
        storyId: 's18',
        storyTitle: 'Tamper Story',
        chapterNumber: '18',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realZipSha,
        createdAt: 18000,
        updatedAt: 18000,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<ManifestValidationException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate18');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('Mã băm SHA-256 tệp pages/001.webp bị sai lệch'));
      expect(await storageRepo.isChapterInstalled(versionId), isFalse);
    });

    // =========================================================================
    // Gate 19: Empty or Missing files List Rejection
    // =========================================================================
    test('Gate 19: Manifest missing files array or empty files list is rejected fail-closed', () async {
      const versionId = 'v19_empty_files';
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c19',
        'storyId': 's19',
        'mediaFormat': 'COMIC',
        'files': <Map<String, dynamic>>[], // Rỗng
      };
      final zipBytes = createTestZip(manifest: manifest, autoPopulateFiles: false);
      final realSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate19',
        chapterVersionId: versionId,
        chapterId: 'c19',
        storyId: 's19',
        storyTitle: 'Empty Files Test',
        chapterNumber: '19',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha,
        createdAt: 19000,
        updatedAt: 19000,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<ManifestValidationException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate19');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('chứa danh sách files không rỗng'));
    });

    // =========================================================================
    // Gate 20: Manifest Path Traversal Rejection
    // =========================================================================
    test('Gate 20: Manifest path traversal attempt in files[].path is blocked', () async {
      const versionId = 'v20_traversal';
      final pageContent = utf8.encode('page');
      final pageSha = sha256.convert(pageContent).toString();
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c20',
        'storyId': 's20',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': '../escaped.txt', 'size': pageContent.length, 'sha256': pageSha}
        ],
      };
      final zipBytes = createTestZip(manifest: manifest, autoPopulateFiles: false);
      final realSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate20',
        chapterVersionId: versionId,
        chapterId: 'c20',
        storyId: 's20',
        storyTitle: 'Traversal Story',
        chapterNumber: '20',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha,
        createdAt: 20000,
        updatedAt: 20000,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<ManifestValidationException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate20');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('path traversal'));
    });

    // =========================================================================
    // Gate 21: Extra Untrusted Files on Disk (Exact Inventory Check)
    // =========================================================================
    test('Gate 21: Extra untrusted file on disk not declared in manifest fails validation', () async {
      const versionId = 'v21_extra_file';
      final pageContent = utf8.encode('page-21');
      final extraContent = utf8.encode('untrusted extra payload');
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c21',
        'storyId': 's21',
        'mediaFormat': 'COMIC',
        'files': [
          {
            'path': 'pages/001.webp',
            'size': pageContent.length,
            'sha256': sha256.convert(pageContent).toString(),
          }
        ],
      };
      final zipBytes = createTestZip(
        manifest: manifest,
        files: {
          'pages/001.webp': pageContent,
          'extra.sh': extraContent,
        },
        autoPopulateFiles: false,
      );
      final realSha = sha256.convert(zipBytes).toString();

      final partFile = await storagePaths.getPartFile(versionId);
      await partFile.writeAsBytes(zipBytes);

      final task = DownloadTask(
        taskId: 'task_gate21',
        chapterVersionId: versionId,
        chapterId: 'c21',
        storyId: 's21',
        storyTitle: 'Extra File Story',
        chapterNumber: '21',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: realSha,
        createdAt: 21000,
        updatedAt: 21000,
      );
      await storageRepo.insertTask(task);

      await expectLater(
        bundleInstaller.installBundle(task),
        throwsA(isA<ManifestValidationException>()),
      );

      final updatedTask = await storageRepo.getTaskById('task_gate21');
      expect(updatedTask?.status, DownloadTaskStatus.failed);
      expect(updatedTask?.errorMessage, contains('Phát hiện tệp lạ không được khai báo'));
    });

    // =========================================================================
    // Gate 22: Valid Installed Orphan with CANCELLED Task Purged (No Resurrection)
    // =========================================================================
    test('Gate 22: Valid installed orphan directory with CANCELLED task is purged and task preserved', () async {
      const versionId = 'v22_cancelled_orphan';
      final pageContent = utf8.encode('page-content-22');
      final pageSha = sha256.convert(pageContent).toString();

      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': versionId,
        'chapterId': 'c22',
        'storyId': 's22',
        'chapterTitle': 'Cancelled Orphan Test',
        'mediaFormat': 'COMIC',
        'files': [
          {'path': 'pages/001.webp', 'size': pageContent.length, 'sha256': pageSha}
        ]
      };

      // Tạo thư mục installed hợp lệ trực tiếp trên đĩa (mồ côi)
      final installedPath = await storagePaths.getInstalledPathForVersion(versionId);
      final installedDir = Directory(installedPath);
      await installedDir.create(recursive: true);
      final manifestFile = File(p.join(installedPath, 'manifest.json'));
      await manifestFile.writeAsString(jsonEncode(manifest));
      final pageFile = File(p.join(installedPath, 'pages', '001.webp'));
      await pageFile.parent.create(recursive: true);
      await pageFile.writeAsBytes(pageContent);

      // Task tồn tại ở trạng thái CANCELLED
      const task = DownloadTask(
        taskId: 'task_gate22',
        chapterVersionId: versionId,
        chapterId: 'c22',
        storyId: 's22',
        storyTitle: 'Cancelled Orphan Story',
        chapterNumber: '22',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.cancelled,
        createdAt: 22000,
        updatedAt: 22000,
      );
      await storageRepo.insertTask(task);

      // Chạy startup reconciliation
      final report = await bundleInstaller.reconcileOnStartup();

      // BẤT BIẾN:
      // 1. Thư mục orphan BỊ XÓA KHỎI ĐĨA
      expect(installedDir.existsSync(), isFalse);
      expect(report.removedOrphanDirs, 1);
      expect(report.reconstructedRows, 0);

      // 2. Task giữ nguyên CANCELLED, TUYỆT ĐỐI KHÔNG BỊ RESURRECT THÀNH READY
      final updatedTask = await storageRepo.getTaskById('task_gate22');
      expect(updatedTask?.status, DownloadTaskStatus.cancelled);

      // 3. zero offline_chapters row
      expect(await storageRepo.isChapterInstalled(versionId), isFalse);
    });
  });
}

/// Helper class mô phỏng hủy tác vụ ngay sau khi atomic rename promotion xảy ra
class _CancelAfterPromoteStoragePaths extends OfflineStoragePaths {
  final CancelToken cancelToken;

  _CancelAfterPromoteStoragePaths({
    required super.customBasePath,
    required this.cancelToken,
  });

  @override
  Future<String> getRootOfflinePath() async {
    cancelToken.cancel('User cancelled download immediately after promotion');
    throw const OfflineInstallationCancelledException('User cancelled download immediately after promotion');
  }
}

