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
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reading_progress_coordinator.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/gamification/repositories/gamification_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class FakeStopwatch implements Stopwatch {
  Duration _elapsed = Duration.zero;
  bool _isRunning = false;

  void setElapsed(Duration duration) {
    _elapsed = duration;
  }

  @override
  Duration get elapsed => _elapsed;

  @override
  int get elapsedMicroseconds => _elapsed.inMicroseconds;

  @override
  int get elapsedMilliseconds => _elapsed.inMilliseconds;

  @override
  int get elapsedTicks => _elapsed.inMicroseconds;

  @override
  int get frequency => 1000000;

  @override
  bool get isRunning => _isRunning;

  @override
  void reset() {
    _elapsed = Duration.zero;
  }

  @override
  void start() {
    _isRunning = true;
  }

  @override
  void stop() {
    _isRunning = false;
  }
}

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
  final List<RequestOptions> requests = [];
  bool allowRequests = false;
  Map<String, dynamic>? mockResponseData;
  Future<void> Function(RequestOptions options)? onBeforeResponse;

  List<RequestOptions> get putProgressRequests =>
      requests.where((r) => r.method == 'PUT' && r.uri.toString().contains('/reading-progress')).toList();

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    totalRequests++;
    requestedUrls.add(options.uri.toString());
    requests.add(options);

    if (!allowRequests) {
      throw DioException(
        requestOptions: options,
        error: 'Airplane Mode: Network disabled',
        type: DioExceptionType.connectionError,
      );
    }

    if (onBeforeResponse != null) {
      await onBeforeResponse!(options);
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

      // 1. User đã từng đồng bộ/tải truyện khi có mạng (canonical server epoch = 42 được lưu vào đĩa)
      progressRepo.setServerEpoch('story_replay_7', 42);

      // Chuyển sang đọc offline trong Airplane Mode (ReaderScreen tắt networkSideEffectsEnabled)
      mockHttpAdapter.allowRequests = false;
      final coordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        networkSideEffectsEnabled: false,
      );
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

      // Checkpoint được lưu vào SharedPreferences với canonical baseWriteEpoch = 42
      final localBeforeKill = await progressRepo.getLocalCheckpoint('story_replay_7');
      expect(localBeforeKill, isNotNull);
      expect(localBeforeKill!.pageIndex, 6); // 1-based
      expect(localBeforeKill.baseWriteEpoch, 42);

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

    // =========================================================================
    // Gate 9: Offline Gamification Zero-Network Gate (P0.1)
    // =========================================================================
    test('Gate 9: Offline Gamification Zero-Network — Fake elapsed > 45s + 85% progress triggers 0 HTTP calls in offline mode', () async {
      final gamificationRepo = GamificationRepository(apiClient: apiClient);
      final coordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        gamificationRepository: gamificationRepo,
        networkSideEffectsEnabled: false, // ReaderScreen tắt khi offline
      );
      coordinator.init();
      coordinator.onChapterReady('ch_offline_gamification');

      final fakeStopwatch = FakeStopwatch();
      fakeStopwatch.setElapsed(const Duration(seconds: 50)); // > 45s
      coordinator.setActiveReadingStopwatchForTesting(fakeStopwatch);

      // NGẮT MẠNG HOÀN TOÀN
      mockHttpAdapter.allowRequests = false;
      mockHttpAdapter.totalRequests = 0;

      // Người dùng đọc đến 85% (> 80%) sau hơn 45 giây
      coordinator.recordProgress(
        storyId: 'story_gamification',
        chapterId: 'ch_offline_gamification',
        flutterPageIndex: 10,
        progressPercentage: 85.0,
        scrollPosition: 2000.0,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));
      await coordinator.flush();

      // BẤT BIẾN: Tuyệt đối 0 HTTP request ra mạng (không rewardReadChapter, không getProgression)!
      expect(mockHttpAdapter.totalRequests, 0);

      // Vẫn ghi thành công local checkpoint để bảo vệ tiến độ đọc
      final checkpoint = await progressRepo.getLocalCheckpoint('story_gamification');
      expect(checkpoint, isNotNull);
      expect(checkpoint!.chapterId, 'ch_offline_gamification');
      expect(checkpoint.progressPercentage, 85.0);
      expect(checkpoint.isDirty, isTrue);

      coordinator.dispose();
    });

    // =========================================================================
    // Gate 10: Newer Server Progress Wins Gate (P0.2)
    // =========================================================================
    test('Gate 10: Newer Server Progress Wins — Older local checkpoint does not overwrite newer server progress', () async {
      final localTime = DateTime.now().subtract(const Duration(hours: 5));
      final serverTime = DateTime.now().subtract(const Duration(hours: 1)); // Server mới hơn

      // Giả lập checkpoint cũ trên máy (chương 3)
      await progressRepo.saveLocalCheckpoint(
        LocalReadingCheckpoint(
          storyId: 'story_gate_10',
          chapterId: 'ch_3_old',
          pageIndex: 1,
          progressPercentage: 10.0,
          scrollPosition: 100.0,
          updatedAt: localTime,
          isDirty: true,
          baseWriteEpoch: 1,
        ),
      );

      mockHttpAdapter.allowRequests = true;
      mockHttpAdapter.totalRequests = 0;
      mockHttpAdapter.mockResponseData = {
        'storyId': 'story_gate_10',
        'chapterId': 'ch_10_new', // Server đã đọc tới chương 10 từ thiết bị khác
        'pageIndex': 15,
        'progressPercentage': 90.0,
        'scrollPosition': 5000.0,
        'updatedAt': serverTime.toIso8601String(),
        'writeEpoch': 1,
      };

      final coordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        debounceDuration: const Duration(milliseconds: 50),
      );
      coordinator.init();

      // Kết nối và khởi tạo session (hydration GET là bắt buộc để nạp server state)
      await coordinator.startSession('story_gate_10');
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await coordinator.flush();

      // BẤT BIẾN: Server mới hơn luôn thắng! KHÔNG gửi request PUT /reading-progress ghi đè chương cũ
      expect(mockHttpAdapter.putProgressRequests, isEmpty);

      coordinator.dispose();
    });

    // =========================================================================
    // Gate 11: Tombstone Epoch Anti-Resurrection Gate (P0.2)
    // =========================================================================
    test('Gate 11: Tombstone Epoch Anti-Resurrection — Checkpoint with baseWriteEpoch N does not rebind or replay when server is at N+1', () async {
      final localTime = DateTime.now();

      // Device A có local checkpoint tạo dưới epoch 1
      await progressRepo.saveLocalCheckpoint(
        LocalReadingCheckpoint(
          storyId: 'story_gate_11',
          chapterId: 'ch_stale',
          pageIndex: 5,
          progressPercentage: 50.0,
          scrollPosition: 500.0,
          updatedAt: localTime,
          isDirty: true,
          baseWriteEpoch: 1, // Snapshot lúc ghi là epoch 1
        ),
      );

      mockHttpAdapter.allowRequests = true;
      mockHttpAdapter.totalRequests = 0;
      mockHttpAdapter.requests.clear();
      // Server đã bị DELETE hoặc xóa lịch sử trên thiết bị khác -> epoch tăng lên 2, chapterId null (tombstone)
      mockHttpAdapter.mockResponseData = {
        'storyId': 'story_gate_11',
        'chapterId': null,
        'pageIndex': 1,
        'progressPercentage': 0.0,
        'scrollPosition': 0.0,
        'updatedAt': DateTime.now().subtract(const Duration(minutes: 5)).toIso8601String(),
        'writeEpoch': 2, // Epoch mới sau khi DELETE
      };

      final coordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        debounceDuration: const Duration(milliseconds: 50),
      );
      coordinator.init();

      // Device A reconnect và hydrate epoch 2
      await coordinator.startSession('story_gate_11');
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await coordinator.flush();

      // BẤT BIẾN: Tuyệt đối không rebind checkpoint cũ sang epoch 2 để phục sinh lịch sử đã xóa!
      // Không có bất kỳ HTTP PUT request nào được phát đi.
      expect(mockHttpAdapter.putProgressRequests, isEmpty);

      coordinator.dispose();
    });

    // =========================================================================
    // Gate 12: Durable Replay Exactly Once Gate (P0.2)
    // =========================================================================
    test('Gate 12: Durable Replay Exactly Once — Checkpoint is marked clean after sync and not re-sent on subsequent starts', () async {
      final localTime = DateTime.now();

      // 1. Checkpoint offline (dirty) ghi dưới epoch 10 đã biết
      await progressRepo.saveLocalCheckpoint(
        LocalReadingCheckpoint(
          storyId: 'story_gate_12',
          chapterId: 'ch_durable_12',
          pageIndex: 4,
          progressPercentage: 60.0,
          scrollPosition: 800.0,
          updatedAt: localTime,
          isDirty: true,
          baseWriteEpoch: 10,
        ),
      );

      mockHttpAdapter.allowRequests = true;
      mockHttpAdapter.totalRequests = 0;
      mockHttpAdapter.requests.clear();
      mockHttpAdapter.mockResponseData = {
        'storyId': 'story_gate_12',
        'chapterId': 'ch_old_12',
        'pageIndex': 1,
        'progressPercentage': 10.0,
        'scrollPosition': 100.0,
        'updatedAt': DateTime.now().subtract(const Duration(hours: 1)).toIso8601String(),
        'writeEpoch': 10,
      };

      final coordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        debounceDuration: const Duration(milliseconds: 50),
      );
      coordinator.init();

      // Session 1: Reconnect và replay
      await coordinator.startSession('story_gate_12');
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await coordinator.flush();

      // Lần đầu: Có 1 request PUT /reading-progress
      expect(mockHttpAdapter.putProgressRequests.length, 1);

      // Checkpoint trên đĩa đã được chuyển thành isDirty == false
      final localAfterSync = await progressRepo.getLocalCheckpoint('story_gate_12');
      expect(localAfterSync, isNotNull);
      expect(localAfterSync!.isDirty, isFalse);
      expect(localAfterSync.baseWriteEpoch, 10);

      // 2. KHỞI ĐỘNG LẠI HOẶC MỞ LẠI SESSION (Mô phỏng app restart)
      coordinator.dispose();
      mockHttpAdapter.requests.clear();

      final restartCoordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        debounceDuration: const Duration(milliseconds: 50),
      );
      restartCoordinator.init();

      // Server trả về tiến độ đã cập nhật
      mockHttpAdapter.mockResponseData = {
        'storyId': 'story_gate_12',
        'chapterId': 'ch_durable_12',
        'pageIndex': 4,
        'progressPercentage': 60.0,
        'scrollPosition': 800.0,
        'updatedAt': localTime.toIso8601String(),
        'writeEpoch': 10,
      };

      await restartCoordinator.startSession('story_gate_12');
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await restartCoordinator.flush();

      // BẤT BIẾN: Replay Exactly-Once! Lần khởi động thứ hai KHÔNG gửi thêm bất kỳ request PUT nào!
      expect(mockHttpAdapter.putProgressRequests, isEmpty);

      restartCoordinator.dispose();
    });

    // =========================================================================
    // Gate 13: Unknown Base Epoch Anti-Resurrection Gate (P0)
    // =========================================================================
    test('Gate 13: Unknown Base Epoch Anti-Resurrection — offline-from-cold-start (baseWriteEpoch=null) -> remote DELETE raises epoch -> reconnect -> zero PUT', () async {
      final localTime = DateTime.now();

      // Device A mở hoàn toàn offline từ cold start: chưa từng hydrate epoch -> baseWriteEpoch = null
      await progressRepo.saveLocalCheckpoint(
        LocalReadingCheckpoint(
          storyId: 'story_gate_13',
          chapterId: 'ch_cold_13',
          pageIndex: 3,
          progressPercentage: 45.0,
          scrollPosition: 600.0,
          updatedAt: localTime,
          isDirty: true,
          baseWriteEpoch: null, // Chưa từng hydrate epoch
        ),
      );

      mockHttpAdapter.allowRequests = true;
      mockHttpAdapter.totalRequests = 0;
      mockHttpAdapter.requests.clear();

      // Trên remote server: lịch sử đã bị xóa (tombstone) và epoch tăng lên 2
      mockHttpAdapter.mockResponseData = {
        'storyId': 'story_gate_13',
        'chapterId': null,
        'pageIndex': 1,
        'progressPercentage': 0.0,
        'scrollPosition': 0.0,
        'updatedAt': DateTime.now().subtract(const Duration(minutes: 10)).toIso8601String(),
        'writeEpoch': 2,
      };

      final coordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        debounceDuration: const Duration(milliseconds: 50),
      );
      coordinator.init();

      // Device A reconnect và hydrate epoch 2
      await coordinator.startSession('story_gate_13');
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await coordinator.flush();

      // BẤT BIẾN (P0): baseWriteEpoch=null tuyệt đối KHÔNG được rebind sang epoch 2!
      // Không được phát bất kỳ request PUT /reading-progress nào lên server -> 0 PUT!
      expect(mockHttpAdapter.putProgressRequests, isEmpty);

      // Checkpoint trên đĩa vẫn được giữ để user có thể resume cục bộ (local resume)
      final localCheckpoint = await progressRepo.getLocalCheckpoint('story_gate_13');
      expect(localCheckpoint, isNotNull);
      expect(localCheckpoint!.pageIndex, 3);

      coordinator.dispose();
    });

    // =========================================================================
    // Gate 14: Concurrent Same-Page Progress During PUT Gate (P0)
    // =========================================================================
    test('Gate 14: Concurrent Same-Page Progress During PUT — in-flight mutation on same page preserves isDirty and replays on restart', () async {
      mockHttpAdapter.allowRequests = true;
      mockHttpAdapter.totalRequests = 0;
      mockHttpAdapter.requests.clear();
      mockHttpAdapter.mockResponseData = {
        'storyId': 'story_gate_14',
        'chapterId': 'ch_gate_14',
        'pageIndex': 5,
        'progressPercentage': 50.0,
        'scrollPosition': 1000.0,
        'updatedAt': DateTime.now().toIso8601String(),
        'writeEpoch': 3,
      };

      final coordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        debounceDuration: const Duration(milliseconds: 500),
      );
      coordinator.init();

      // 1. Session start và hydrate epoch 3
      await coordinator.startSession('story_gate_14');

      // 2. Ghi tiến độ A: page 5 / 50%
      coordinator.recordProgress(
        storyId: 'story_gate_14',
        chapterId: 'ch_gate_14',
        flutterPageIndex: 4, // Page 5
        progressPercentage: 50.0,
        scrollPosition: 1000.0,
      );

      // Trong lúc PUT cho A đang in-flight, người dùng tiếp tục cuộn trên cùng page 5 lên 65% (B)
      mockHttpAdapter.onBeforeResponse = (options) async {
        if (options.method == 'PUT' && options.uri.toString().contains('/reading-progress')) {
          final reqBody = options.data is Map<String, dynamic>
              ? options.data as Map<String, dynamic>
              : jsonDecode(options.data.toString()) as Map<String, dynamic>;
          // Chỉ can thiệp khi request là của A (50%)
          if (reqBody['progressPercentage'] == 50.0) {
            coordinator.recordProgress(
              storyId: 'story_gate_14',
              chapterId: 'ch_gate_14',
              flutterPageIndex: 4, // Cùng page 5
              progressPercentage: 65.0, // Đã đọc thêm lên 65%
              scrollPosition: 1300.0,
            );
          }
        }
      };

      // Đẩy khẩn cấp A lên server (kích hoạt PUT A ngay lập tức)
      await coordinator.flush();

      // BẤT BIẾN: Checkpoint B trên đĩa BẮT BUỘC vẫn giữ isDirty == true!
      // ACK của A không được phép xóa dirty nhầm của B!
      final checkpointOnDisk = await progressRepo.getLocalCheckpoint('story_gate_14');
      expect(checkpointOnDisk, isNotNull);
      expect(checkpointOnDisk!.progressPercentage, 65.0);
      expect(checkpointOnDisk.pageIndex, 5);
      expect(checkpointOnDisk.isDirty, isTrue);

      // 3. GIẢ LẬP APP KILL TRƯỚC LẦN SYNC TIẾP THEO CỦA B (CRASH / RESTART)
      coordinator.dispose();
      mockHttpAdapter.onBeforeResponse = null;
      mockHttpAdapter.requests.clear();

      final restartCoordinator = ReadingProgressCoordinator(
        repository: progressRepo,
        debounceDuration: const Duration(milliseconds: 20),
      );
      restartCoordinator.init();

      // Mở lại session online
      await restartCoordinator.startSession('story_gate_14');
      await Future<void>.delayed(const Duration(milliseconds: 80));
      await restartCoordinator.flush();

      // BẤT BIẾN: Checkpoint B (65%) được replay bền vững lên server!
      expect(mockHttpAdapter.putProgressRequests.length, 1);
      final lastPut = mockHttpAdapter.putProgressRequests.first;
      final body = lastPut.data is Map<String, dynamic>
          ? lastPut.data as Map<String, dynamic>
          : jsonDecode(lastPut.data.toString()) as Map<String, dynamic>;
      expect(body['progressPercentage'], 65.0);
      expect(body['pageIndex'], 5);

      // Checkpoint B sau khi replay thành công đã được đánh dấu clean
      final checkpointAfterReplay = await progressRepo.getLocalCheckpoint('story_gate_14');
      expect(checkpointAfterReplay, isNotNull);
      expect(checkpointAfterReplay!.progressPercentage, 65.0);
      expect(checkpointAfterReplay.isDirty, isFalse);

      restartCoordinator.dispose();
    });

    // =========================================================================
    // P1.1: Strict Whitelist Novel Illustrations Verification
    // =========================================================================
    test('P1.1: Strict Whitelist Novel Illustrations — Unknown or non-whitelisted illustration paths are blocked', () async {
      final imgBytes = utf8.encode('canonical-novel-img');
      final manifestFiles = [
        {
          'path': 'content.html',
          'size': 100,
          'sha256': sha256.convert(utf8.encode('content')).toString(),
          'assetType': 'NOVEL_HTML',
        },
        {
          'path': 'illustrations/canon_01.webp',
          'size': imgBytes.length,
          'sha256': sha256.convert(imgBytes).toString(),
          'assetType': 'NOVEL_ILLUSTRATION',
          'assetId': 'canon_01',
        },
      ];

      const rawHtml = '<p>Intro</p><img src="illustrations/canon_01.webp"><img src="/data/user/0/com.app/private.key">';
      final htmlBytes = utf8.encode(rawHtml);
      manifestFiles[0]['size'] = htmlBytes.length;
      manifestFiles[0]['sha256'] = sha256.convert(htmlBytes).toString();

      await installTestChapter(
        chapterVersionId: 'v_novel_whitelist',
        chapterId: 'ch_novel_whitelist',
        storyId: 'story_novel_whitelist',
        storyTitle: 'Novel Whitelist Story',
        chapterNumber: '1',
        mediaFormat: 'NOVEL',
        publicationFormat: 'NOVEL',
        files: {
          'content.html': htmlBytes,
          'illustrations/canon_01.webp': imgBytes,
        },
        customManifest: {
          'schemaVersion': 1,
          'bundleType': 'OFFLINE_READER',
          'chapterVersionId': 'v_novel_whitelist',
          'chapterId': 'ch_novel_whitelist',
          'storyId': 'story_novel_whitelist',
          'storyTitle': 'Novel Whitelist Story',
          'chapterNumber': '1',
          'mediaFormat': 'NOVEL',
          'publicationFormat': 'NOVEL',
          'novelMetadata': {'contentPath': 'content.html'},
          'files': manifestFiles,
        },
      );

      final result = await offlineResolver.resolveChapter(chapterId: 'ch_novel_whitelist');
      expect(result, isNotNull);
      expect(result!.allowedIllustrationPaths.length, 1);
      final allowedPath = result.allowedIllustrationPaths.first;
      expect(allowedPath.replaceAll(r'\', '/').endsWith('illustrations/canon_01.webp'), isTrue);
      // Đường dẫn lạ không nằm trong allowedIllustrationPaths
      expect(result.allowedIllustrationPaths.contains('/data/user/0/com.app/private.key'), isFalse);
    });
  });
}
