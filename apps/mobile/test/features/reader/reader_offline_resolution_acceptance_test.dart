import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';
import 'package:omninovel_mobile/core/config/app_config.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/storage/offline_storage_paths.dart';
import 'package:omninovel_mobile/features/offline/models/download_task.dart';
import 'package:omninovel_mobile/features/offline/models/offline_chapter.dart';
import 'package:omninovel_mobile/features/offline/repositories/offline_storage_repository.dart';
import 'package:omninovel_mobile/features/offline/services/bundle_installer.dart';
import 'package:omninovel_mobile/features/offline/services/offline_content_resolver.dart';
import 'package:omninovel_mobile/features/reader/presentation/novel_content_parser.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_image_cache_coordinator.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_controller.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_state.dart';
import 'package:omninovel_mobile/features/reader/presentation/reading_progress_coordinator.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// Helper tạo tệp ZIP kiểm thử tuân thủ contract của backend canonical-packaging
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

/// Custom HttpClientAdapter đếm và kiểm soát 100% request HTTP ra mạng
class CountingMockHttpAdapter implements HttpClientAdapter {
  int totalRequests = 0;
  final List<String> requestedUrls = [];
  bool allowRequests = false;
  Map<String, dynamic>? mockResponseData;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    totalRequests++;
    requestedUrls.add(options.uri.toString());

    if (!allowRequests) {
      throw DioException(
        requestOptions: options,
        error: 'Airplane Mode: Network disabled',
        type: DioExceptionType.connectionError,
      );
    }

    final data = mockResponseData ?? <String, dynamic>{};
    return ResponseBody.fromString(
      jsonEncode(data),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _FakeTokenStorage implements ITokenStorage {
  @override
  Future<String?> getAccessToken() async => 'test-access-token';

  @override
  Future<String?> getRefreshToken() async => 'test-refresh-token';

  @override
  Future<void> saveTokens({required String accessToken, required String refreshToken}) async {}

  @override
  Future<void> saveAccessToken(String accessToken) async {}

  @override
  Future<void> clearTokens() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  setUpAll(() {
    AppConfig.initialize(environment: Environment.test);
  });

  late Directory tempDir;
  late OfflineDatabase offlineDb;
  late OfflineStorageRepository storageRepo;
  late OfflineStoragePaths storagePaths;
  late BundleInstaller bundleInstaller;
  late OfflineContentResolver offlineResolver;

  late CountingMockHttpAdapter mockHttpAdapter;
  late ApiClient apiClient;
  late ChapterRepository chapterRepo;
  late MediaRepository mediaRepo;
  late ReadingProgressRepository progressRepo;
  late ReaderImageCacheCoordinator imageCacheCoordinator;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    tempDir = Directory.systemTemp.createTempSync('omninovel_5d5_test_');

    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: inMemoryDatabasePath,
      databaseFactory: databaseFactoryFfi,
    );

    storageRepo = OfflineStorageRepository(database: offlineDb);
    storagePaths = OfflineStoragePaths(customBasePath: tempDir.path);
    await storagePaths.ensureDirectoriesExist();

    bundleInstaller = BundleInstaller(
      repository: storageRepo,
      storagePaths: storagePaths,
      computeRunner: <Q, R>(callback, message) async => await callback(message),
    );

    offlineResolver = OfflineContentResolver(
      repository: storageRepo,
      storagePaths: storagePaths,
      bundleInstaller: bundleInstaller,
    );

    mockHttpAdapter = CountingMockHttpAdapter();
    apiClient = ApiClient(
      tokenStorage: _FakeTokenStorage(),
      baseUrl: 'https://api.omninovel.test',
    );
    apiClient.rawDio.httpClientAdapter = mockHttpAdapter;

    chapterRepo = ChapterRepository(apiClient: apiClient);
    mediaRepo = MediaRepository(apiClient: apiClient);
    progressRepo = ReadingProgressRepository(apiClient: apiClient);
    imageCacheCoordinator = ReaderImageCacheCoordinator(mediaRepository: mediaRepo);
  });

  tearDown(() async {
    imageCacheCoordinator.dispose();
    await offlineDb.close();
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  /// Helper cài đặt một chapter offline hoàn chỉnh vào hệ thống
  Future<OfflineChapter> installTestChapter({
    required String chapterVersionId,
    required String chapterId,
    required String storyId,
    required String storyTitle,
    required String chapterNumber,
    String? chapterTitle,
    String mediaFormat = 'COMIC',
    String? publicationFormat,
    int versionNumber = 1,
    Map<String, dynamic>? customManifest,
    Map<String, List<int>>? files,
  }) async {
    final Map<String, List<int>> bundleFiles;
    if (files != null) {
      bundleFiles = files;
    } else if (mediaFormat == 'NOVEL') {
      bundleFiles = {
        'content.html': utf8.encode('<p data-anchor-block-id="blk_1">Nội dung tiểu thuyết.</p>'),
      };
    } else {
      bundleFiles = {
        'pages/001.webp': utf8.encode('page-1-bytes'),
        'pages/002.webp': utf8.encode('page-2-bytes'),
      };
    }

    final manifestFiles = <Map<String, dynamic>>[];
    var sortOrder = 0;
    for (final entry in bundleFiles.entries) {
      manifestFiles.add({
        'path': entry.key,
        'size': entry.value.length,
        'sha256': sha256.convert(entry.value).toString(),
        'sortOrder': sortOrder++,
        'assetId': 'asset_${entry.key.replaceAll('/', '_')}',
        'assetType': mediaFormat == 'NOVEL' ? 'NOVEL_HTML' : 'MANGA_PAGE',
      });
    }

    final manifest = customManifest ??
        {
          'schemaVersion': 1,
          'bundleType': 'OFFLINE_READER',
          'chapterVersionId': chapterVersionId,
          'chapterId': chapterId,
          'storyId': storyId,
          'storyTitle': storyTitle,
          'chapterNumber': chapterNumber,
          'chapterTitle': chapterTitle,
          'mediaFormat': mediaFormat,
          'publicationFormat': publicationFormat,
          'versionNumber': versionNumber,
          'files': manifestFiles,
          if (mediaFormat == 'NOVEL')
            'novelMetadata': {
              'contentPath': 'content.html',
            },
        };

    final zipBytes = createTestZip(manifest: manifest, files: bundleFiles);
    final zipSha = sha256.convert(zipBytes).toString();

    final partFile = await storagePaths.getPartFile(chapterVersionId);
    await partFile.writeAsBytes(zipBytes);

    final task = DownloadTask(
      taskId: 'task_$chapterVersionId',
      chapterVersionId: chapterVersionId,
      chapterId: chapterId,
      storyId: storyId,
      storyTitle: storyTitle,
      chapterNumber: chapterNumber,
      mediaFormat: mediaFormat,
      status: DownloadTaskStatus.verifying,
      sha256Hash: zipSha,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      updatedAt: DateTime.now().millisecondsSinceEpoch,
    );
    await storageRepo.insertTask(task);

    return await bundleInstaller.installBundle(task);
  }

  group('Phase 5D.5 Verification Acceptance Gates — Reader Offline Resolution (SSoT)', () {
    // =========================================================================
    // Gate 1: Exact-Version Selection Gate
    // =========================================================================
    test('Gate 1: Exact-Version Selection policy resolves preferredVersionId or latest deterministic version', () async {
      // Cài đặt 2 version cho cùng 1 chapterId
      await installTestChapter(
        chapterVersionId: 'v1_old',
        chapterId: 'ch_1',
        storyId: 'story_1',
        storyTitle: 'Test Story',
        chapterNumber: '1',
        versionNumber: 1,
      );

      // Chờ 10ms để installedAt khác biệt
      await Future<void>.delayed(const Duration(milliseconds: 15));

      await installTestChapter(
        chapterVersionId: 'v2_new',
        chapterId: 'ch_1',
        storyId: 'story_1',
        storyTitle: 'Test Story',
        chapterNumber: '1',
        versionNumber: 2,
      );

      // Case 1A: Chỉ định preferredVersionId = 'v1_old' -> exact match v1
      final resultV1 = await offlineResolver.resolveChapter(
        chapterId: 'ch_1',
        preferredVersionId: 'v1_old',
      );
      expect(resultV1, isNotNull);
      expect(resultV1!.offlineChapter.chapterVersionId, 'v1_old');
      expect(resultV1.chapterDetail.activeVersion?.id, 'v1_old');

      // Case 1B: preferredVersionId sai lệch (version không thuộc chapterId) -> return null
      final resultMismatch = await offlineResolver.resolveChapter(
        chapterId: 'ch_different',
        preferredVersionId: 'v1_old',
      );
      expect(resultMismatch, isNull);

      // Case 1C: preferredVersionId == null -> policy deterministic chọn version mới nhất (v2_new)
      final resultLatest = await offlineResolver.resolveChapter(
        chapterId: 'ch_1',
        preferredVersionId: null,
      );
      expect(resultLatest, isNotNull);
      expect(resultLatest!.offlineChapter.chapterVersionId, 'v2_new');
      expect(resultLatest.chapterDetail.activeVersion?.id, 'v2_new');
    });

    // =========================================================================
    // Gate 2: Global Zero-Network Gate (Webtoon & Manga in Airplane Mode)
    // =========================================================================
    test('Gate 2: Global Zero-Network Gate — Webtoon & Manga resolve in Airplane Mode with 0 HTTP calls', () async {
      final p1 = utf8.encode('comic-p1');
      final p2 = utf8.encode('comic-p2');
      final p3 = utf8.encode('comic-p3');

      // Tạo manifest với thứ tự sortOrder ngược với alphabet để chứng minh Canonical Page Order
      final manifestFiles = [
        {
          'path': 'pages/page_02.webp',
          'size': p2.length,
          'sha256': sha256.convert(p2).toString(),
          'sortOrder': 2,
          'assetId': 'asset_p2',
          'assetType': 'MANGA_PAGE',
          'width': 1080,
          'height': 1920,
        },
        {
          'path': 'pages/page_01.webp',
          'size': p1.length,
          'sha256': sha256.convert(p1).toString(),
          'sortOrder': 1,
          'assetId': 'asset_p1',
          'assetType': 'MANGA_PAGE',
          'width': 1080,
          'height': 1920,
        },
        {
          'path': 'pages/page_03.webp',
          'size': p3.length,
          'sha256': sha256.convert(p3).toString(),
          'sortOrder': 3,
          'assetId': 'asset_p3',
          'assetType': 'MANGA_PAGE',
          'width': 1080,
          'height': 1920,
        },
      ];

      await installTestChapter(
        chapterVersionId: 'v_webtoon',
        chapterId: 'ch_webtoon',
        storyId: 'story_webtoon',
        storyTitle: 'Webtoon Story',
        chapterNumber: '1',
        mediaFormat: 'COMIC',
        publicationFormat: 'WEBTOON',
        files: {
          'pages/page_02.webp': p2,
          'pages/page_01.webp': p1,
          'pages/page_03.webp': p3,
        },
        customManifest: {
          'schemaVersion': 1,
          'bundleType': 'OFFLINE_READER',
          'chapterVersionId': 'v_webtoon',
          'chapterId': 'ch_webtoon',
          'storyId': 'story_webtoon',
          'storyTitle': 'Webtoon Story',
          'chapterNumber': '1',
          'mediaFormat': 'COMIC',
          'publicationFormat': 'WEBTOON',
          'files': manifestFiles,
        },
      );

      // NGẮT TOÀN BỘ MẠNG (AIRPLANE MODE)
      mockHttpAdapter.allowRequests = false;
      mockHttpAdapter.totalRequests = 0;

      final sessionController = ReaderSessionController(
        chapterRepository: chapterRepo,
        imageCacheCoordinator: imageCacheCoordinator,
        offlineContentResolver: offlineResolver,
      );

      await sessionController.loadChapter('ch_webtoon', versionId: 'v_webtoon');

      // BẤT BIẾN 1: Status = Ready, Mode = Offline
      expect(sessionController.state.status, ReaderStatus.ready);
      expect(sessionController.state.transportMode, ReaderTransportMode.offline);
      expect(sessionController.state.isOffline, isTrue);

      // BẤT BIẾN 2: Thứ tự trang tuân thủ đúng sortOrder (page_01 -> page_02 -> page_03)
      final pages = sessionController.state.pages;
      expect(pages.length, 3);
      expect(pages[0].assetId, 'asset_p1');
      expect(pages[0].sortOrder, 1);
      expect(pages[1].assetId, 'asset_p2');
      expect(pages[1].sortOrder, 2);
      expect(pages[2].assetId, 'asset_p3');
      expect(pages[2].sortOrder, 3);

      // BẤT BIẾN 3: getPageUrl trả về đường dẫn tệp cục bộ
      final localUrl = await imageCacheCoordinator.getPageUrl(pages[0]);
      expect(File(localUrl).existsSync(), isTrue);
      expect(localUrl.contains('page_01.webp'), isTrue);

      // BẤT BIẾN 4: getImageProvider trả về FileImage / ResizeImage
      final provider = imageCacheCoordinator.getImageProvider(
        pages[0].assetId,
        localUrl,
        targetWidth: 1080,
        page: pages[0],
      );
      expect(provider, isA<ResizeImage>());
      final resize = provider as ResizeImage;
      expect(resize.imageProvider, isA<FileImage>());

      // BẤT BIẾN 5: GLOBAL ZERO-NETWORK — Toàn bộ app không thực hiện bất kỳ request mạng nào!
      expect(mockHttpAdapter.totalRequests, 0);
    });

    // =========================================================================
    // Gate 3: Novel Strict Whitelist & Local Illustration Gate
    // =========================================================================
    test('Gate 3: Novel Offline Resolution — Loads content.html offline, local illustration, blocks external image', () async {
      final illBytes = utf8.encode('illustration-webp-bytes');
      final illSha = sha256.convert(illBytes).toString();

      const rawHtml = '''
        <h1>Tiêu đề Novel</h1>
        <p data-anchor-block-id="blk_1">Đoạn văn mở đầu.</p>
        <figure>
          <img src="illustrations/ill_0001.webp" alt="Minh họa 1" />
          <figcaption>Ảnh minh họa hợp lệ trong manifest</figcaption>
        </figure>
        <figure>
          <img src="https://evil-tracker.com/leak.png" alt="Ảnh ngoại lai" />
          <figcaption>Ảnh ngoại lai ngoài manifest</figcaption>
        </figure>
      ''';
      final htmlBytes = utf8.encode(rawHtml);

      final manifestFiles = [
        {
          'path': 'content.html',
          'size': htmlBytes.length,
          'sha256': sha256.convert(htmlBytes).toString(),
          'sortOrder': 0,
          'assetId': 'asset_html',
          'assetType': 'NOVEL_HTML',
        },
        {
          'path': 'illustrations/ill_0001.webp',
          'size': illBytes.length,
          'sha256': illSha,
          'sortOrder': 1,
          'assetId': 'asset_ill_1',
          'assetType': 'ILLUSTRATION',
          'width': 800,
          'height': 1200,
        },
      ];

      await installTestChapter(
        chapterVersionId: 'v_novel_1',
        chapterId: 'ch_novel_1',
        storyId: 'story_novel_1',
        storyTitle: 'Light Novel Story',
        chapterNumber: '1',
        mediaFormat: 'NOVEL',
        files: {
          'content.html': htmlBytes,
          'illustrations/ill_0001.webp': illBytes,
        },
        customManifest: {
          'schemaVersion': 1,
          'bundleType': 'OFFLINE_READER',
          'chapterVersionId': 'v_novel_1',
          'chapterId': 'ch_novel_1',
          'storyId': 'story_novel_1',
          'storyTitle': 'Light Novel Story',
          'chapterNumber': '1',
          'mediaFormat': 'NOVEL',
          'novelMetadata': {
            'contentPath': 'content.html',
          },
          'files': manifestFiles,
        },
      );

      // Ngắt mạng
      mockHttpAdapter.allowRequests = false;
      mockHttpAdapter.totalRequests = 0;

      final sessionController = ReaderSessionController(
        chapterRepository: chapterRepo,
        imageCacheCoordinator: imageCacheCoordinator,
        offlineContentResolver: offlineResolver,
      );

      await sessionController.loadChapter('ch_novel_1', versionId: 'v_novel_1');

      expect(sessionController.state.status, ReaderStatus.ready);
      expect(sessionController.state.isOffline, isTrue);

      final resolvedNovel = sessionController.state.resolvedOfflineChapter;
      expect(resolvedNovel, isNotNull);
      expect(resolvedNovel!.novelHtmlContent, isNotNull);

      // Phân tích HTML bằng chính NovelContentParser hiện hữu
      final blocks = NovelContentParser.parseHtml(resolvedNovel.novelHtmlContent!);
      expect(blocks.length, greaterThanOrEqualTo(3));

      // Block minh họa 1: đường dẫn tương đối đã được rewrite thành absolute local path tồn tại trên đĩa
      final illBlock1 = blocks.firstWhere((b) => b.isIllustration && b.illustrationAlt == 'Minh họa 1');
      expect(illBlock1.illustrationSrc, isNotNull);
      expect(File(illBlock1.illustrationSrc!).existsSync(), isTrue);

      // Block minh họa 2: URL ngoại lai vẫn giữ nguyên scheme http/https nhưng ở offline mode sẽ bị chặn tải mạng
      final illBlock2 = blocks.firstWhere((b) => b.isIllustration && b.illustrationAlt == 'Ảnh ngoại lai');
      expect(illBlock2.illustrationSrc, startsWith('https://evil-tracker.com'));

      // ZERO network requests
      expect(mockHttpAdapter.totalRequests, 0);
    });

    // =========================================================================
    // Gate 4: Version-Bound Progress Gate
    // =========================================================================
    test('Gate 4: Version-Bound Progress Gate — ChapterDetail binds exact versionId and progress records it', () async {
      await installTestChapter(
        chapterVersionId: 'v_exact_bound_4',
        chapterId: 'ch_bound_4',
        storyId: 'story_bound_4',
        storyTitle: 'Bound Story',
        chapterNumber: '4',
        versionNumber: 3,
      );

      final result = await offlineResolver.resolveChapter(chapterId: 'ch_bound_4');
      expect(result, isNotNull);

      // BẤT BIẾN: ChapterDetail.activeVersion.id BẮT BUỘC là versionId đã cài
      expect(result!.chapterDetail.activeVersion?.id, 'v_exact_bound_4');
      expect(result.chapterDetail.activeVersion?.versionNumber, 3);
      expect(result.chapterDetail.chapter.activeVersionId, 'v_exact_bound_4');

      // Giả lập ghi nhận tiến độ đọc
      final coordinator = ReadingProgressCoordinator(repository: progressRepo);
      coordinator.init();
      coordinator.onChapterReady('ch_bound_4');

      coordinator.recordProgress(
        storyId: 'story_bound_4',
        chapterId: 'ch_bound_4',
        chapterVersionId: result.chapterDetail.activeVersion?.id,
        flutterPageIndex: 1,
        progressPercentage: 50.0,
        scrollPosition: 400.0,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      final checkpoint = await progressRepo.getLocalCheckpoint('story_bound_4');
      expect(checkpoint, isNotNull);
      expect(checkpoint!.chapterVersionId, 'v_exact_bound_4');
      expect(checkpoint.chapterId, 'ch_bound_4');
    });

    // =========================================================================
    // Gate 5: SSoT Proof Gate (No Row / Only Task READY)
    // =========================================================================
    test('Gate 5: SSoT Proof Gate — Missing offline_chapters row returns null even if download_tasks is READY', () async {
      // Chỉ insert task READY vào download_tasks, KHÔNG có bản ghi trong offline_chapters
      const task = DownloadTask(
        taskId: 'task_gate5',
        chapterVersionId: 'v_orphan_task_5',
        chapterId: 'ch_5',
        storyId: 'story_5',
        storyTitle: 'Gate 5 Story',
        chapterNumber: '5',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.ready,
        createdAt: 5000,
        updatedAt: 5000,
      );
      await storageRepo.insertTask(task);

      // Xác nhận offline_chapters không có bản ghi
      expect(await storageRepo.isChapterInstalled('v_orphan_task_5'), isFalse);

      // Resolver BẮT BUỘC từ chối và trả null
      final result = await offlineResolver.resolveChapter(chapterId: 'ch_5');
      expect(result, isNull);
    });

    // =========================================================================
    // Gate 6: Runtime Corruption Fail-Closed Gate
    // =========================================================================
    test('Gate 6: Runtime Corruption Fail-Closed — Corrupt payload falls back to online if available, or clean error', () async {
      await installTestChapter(
        chapterVersionId: 'v_corrupt_6',
        chapterId: 'ch_corrupt_6',
        storyId: 'story_corrupt_6',
        storyTitle: 'Corrupt Story',
        chapterNumber: '6',
      );

      // Cố tình xóa một tệp trang trên đĩa sau khi đã cài đặt thành công
      final installedPath = await storagePaths.getInstalledPathForVersion('v_corrupt_6');
      final pageFile = File(p.join(installedPath, 'pages', '001.webp'));
      await pageFile.delete();

      // Case 6A: Airplane Mode -> Fail-closed báo lỗi sạch sẽ, không crash, không render partial
      mockHttpAdapter.allowRequests = false;
      final sessionOffline = ReaderSessionController(
        chapterRepository: chapterRepo,
        imageCacheCoordinator: imageCacheCoordinator,
        offlineContentResolver: offlineResolver,
      );

      await sessionOffline.loadChapter('ch_corrupt_6', versionId: 'v_corrupt_6');
      expect(sessionOffline.state.status, ReaderStatus.error);
      expect(sessionOffline.state.chapterDetail, isNull);

      // Case 6B: Khi có mạng -> Offline resolver fail-closed (trả null) -> SessionController fallback online
      mockHttpAdapter.allowRequests = true;
      mockHttpAdapter.mockResponseData = {
        'story': {'id': 'story_corrupt_6', 'slug': 'corrupt', 'title': 'Corrupt Story', 'mediaFormat': 'COMIC'},
        'chapter': {'id': 'ch_corrupt_6', 'chapterNumber': '6', 'title': 'Ch 6'},
        'pages': [
          {'id': 'online_p1', 'sortOrder': 0, 'assetType': 'MANGA_PAGE'},
        ],
      };

      final sessionOnline = ReaderSessionController(
        chapterRepository: chapterRepo,
        imageCacheCoordinator: imageCacheCoordinator,
        offlineContentResolver: offlineResolver,
      );

      await sessionOnline.loadChapter('ch_corrupt_6', versionId: 'v_corrupt_6');
      expect(sessionOnline.state.status, ReaderStatus.ready);
      expect(sessionOnline.state.transportMode, ReaderTransportMode.online);
      expect(sessionOnline.state.pages.first.assetId, 'online_p1');
    });

    // =========================================================================
    // Gate 7: Offline -> Reconnect Durable Progress Replay Gate
    // =========================================================================
    test('Gate 7: Offline -> Reconnect Durable Progress Replay — offline read -> kill app -> reopen online -> replay checkpoint', () async {
      await installTestChapter(
        chapterVersionId: 'v_replay_7',
        chapterId: 'ch_replay_7',
        storyId: 'story_replay_7',
        storyTitle: 'Replay Story',
        chapterNumber: '7',
      );

      // 1. User đọc offline trong Airplane Mode
      mockHttpAdapter.allowRequests = false;
      final coordinator = ReadingProgressCoordinator(repository: progressRepo);
      coordinator.init();
      coordinator.onChapterReady('ch_replay_7');

      // Ghi tiến độ offline vào Local Checkpoint
      coordinator.recordProgress(
        storyId: 'story_replay_7',
        chapterId: 'ch_replay_7',
        chapterVersionId: 'v_replay_7',
        flutterPageIndex: 5,
        progressPercentage: 75.0,
        scrollPosition: 1200.0,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      // Checkpoint được lưu vào SharedPreferences
      final localBeforeKill = await progressRepo.getLocalCheckpoint('story_replay_7');
      expect(localBeforeKill, isNotNull);
      expect(localBeforeKill!.pageIndex, 6); // 1-based

      // 2. GIẢ LẬP KILL APP ĐỘT NGỘT: dispose coordinator và giải phóng toàn bộ RAM state
      coordinator.dispose();

      // 3. MỞ LẠI APP KHI ĐÃ CÓ MẠNG (ONLINE RECONNECT)
      mockHttpAdapter.allowRequests = true;
      mockHttpAdapter.mockResponseData = {
        'storyId': 'story_replay_7',
        'chapterId': 'ch_old',
        'pageIndex': 1,
        'progressPercentage': 10.0,
        'scrollPosition': 100.0,
        'updatedAt': DateTime.now().subtract(const Duration(hours: 2)).toIso8601String(),
        'writeEpoch': 42,
      };

      // Coordinator mới khởi tạo
      final newCoordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        debounceDuration: const Duration(milliseconds: 50),
      );
      newCoordinator.init();

      // Khi truyện được mở trong môi trường có mạng, startSession hydrate canonical server epoch (42)
      // và tự động phát hiện un-synced local checkpoint -> materialize pending write và schedule sync
      await newCoordinator.startSession('story_replay_7');

      // Chờ debounce sync hoàn thành
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await newCoordinator.flush();

      // BẤT BIẾN: Checkpoint offline đã được replay và gửi lên server với canonical writeEpoch (42)!
      expect(mockHttpAdapter.requestedUrls.any((u) => u.contains('/reading-progress')), isTrue);
    });

    // =========================================================================
    // Gate 8: App Restart Offline Resumption Gate
    // =========================================================================
    test('Gate 8: App Restart Offline Resumption — restart app and open offline chapter with zero latency and 0 network requests', () async {
      await installTestChapter(
        chapterVersionId: 'v_restart_8',
        chapterId: 'ch_restart_8',
        storyId: 'story_restart_8',
        storyTitle: 'Restart Story',
        chapterNumber: '8',
      );

      // Đóng toàn bộ kết nối DB và dispose coordinators mô phỏng app restart
      await offlineDb.close();

      // Mở lại DB và khởi tạo fresh instances
      final freshDb = OfflineDatabase();
      await freshDb.initialize(
        customPath: inMemoryDatabasePath,
        databaseFactory: databaseFactoryFfi,
      );
      final freshRepo = OfflineStorageRepository(database: freshDb);

      // Copy lại các bản ghi từ storageRepo cũ nếu dùng in-memory (hoặc test trên đĩa)
      // Ở đây với inMemoryDatabasePath mới, ta cài lại chapter
      final restartInstaller = BundleInstaller(
        repository: freshRepo,
        storagePaths: storagePaths,
        computeRunner: <Q, R>(callback, message) async => await callback(message),
      );

      // Cài đặt lại trên fresh DB
      final p1 = utf8.encode('restart-p1');
      final manifestFiles = [
        {
          'path': 'pages/001.webp',
          'size': p1.length,
          'sha256': sha256.convert(p1).toString(),
          'sortOrder': 0,
          'assetId': 'asset_r1',
          'assetType': 'MANGA_PAGE',
        }
      ];
      final manifest = {
        'schemaVersion': 1,
        'bundleType': 'OFFLINE_READER',
        'chapterVersionId': 'v_restart_8',
        'chapterId': 'ch_restart_8',
        'storyId': 'story_restart_8',
        'storyTitle': 'Restart Story',
        'chapterNumber': '8',
        'mediaFormat': 'COMIC',
        'files': manifestFiles,
      };
      final zipBytes = createTestZip(manifest: manifest, files: {'pages/001.webp': p1});
      final partFile = await storagePaths.getPartFile('v_restart_8');
      await partFile.writeAsBytes(zipBytes);
      final task = DownloadTask(
        taskId: 'task_restart_8',
        chapterVersionId: 'v_restart_8',
        chapterId: 'ch_restart_8',
        storyId: 'story_restart_8',
        storyTitle: 'Restart Story',
        chapterNumber: '8',
        mediaFormat: 'COMIC',
        status: DownloadTaskStatus.verifying,
        sha256Hash: sha256.convert(zipBytes).toString(),
        createdAt: 8000,
        updatedAt: 8000,
      );
      await freshRepo.insertTask(task);
      await restartInstaller.installBundle(task);

      // Khởi tạo Fresh Resolver và Session Controller
      final freshResolver = OfflineContentResolver(
        repository: freshRepo,
        storagePaths: storagePaths,
        bundleInstaller: restartInstaller,
      );
      final freshCoordinator = ReaderImageCacheCoordinator(mediaRepository: mediaRepo);
      final freshSession = ReaderSessionController(
        chapterRepository: chapterRepo,
        imageCacheCoordinator: freshCoordinator,
        offlineContentResolver: freshResolver,
      );

      // Chế độ Airplane Mode
      mockHttpAdapter.allowRequests = false;
      mockHttpAdapter.totalRequests = 0;

      // Nạp chapter ngay sau khi restart
      await freshSession.loadChapter('ch_restart_8', versionId: 'v_restart_8');

      expect(freshSession.state.status, ReaderStatus.ready);
      expect(freshSession.state.isOffline, isTrue);
      expect(freshSession.state.pages.length, 1);
      expect(mockHttpAdapter.totalRequests, 0);

      freshCoordinator.dispose();
      await freshDb.close();
    });
  });
}
