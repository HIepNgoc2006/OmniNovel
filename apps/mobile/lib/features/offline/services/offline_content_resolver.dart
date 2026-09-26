import 'dart:io';
import 'package:path/path.dart' as p;
import '../../../core/storage/offline_storage_paths.dart';
import '../../reader/models/reader_models.dart';
import '../models/offline_chapter.dart';
import '../repositories/offline_storage_repository.dart';
import 'bundle_installer.dart';

/// Kết quả giải quyết nội dung chương truyện từ bộ lưu trữ ngoại tuyến.
class ResolvedOfflineChapter {
  final OfflineChapter offlineChapter;
  final Map<String, dynamic> manifest;
  final String installedPath;
  final ChapterDetail chapterDetail;
  final Map<String, File> localAssetFiles; // assetId -> File
  final String? novelHtmlContent; // Nội dung HTML đã resolve đường dẫn minh họa cục bộ
  final Set<String> allowedIllustrationPaths; // P1.1 Canonical Whitelist ảnh minh họa

  const ResolvedOfflineChapter({
    required this.offlineChapter,
    required this.manifest,
    required this.installedPath,
    required this.chapterDetail,
    required this.localAssetFiles,
    this.novelHtmlContent,
    this.allowedIllustrationPaths = const {},
  });
}

/// Bộ giải quyết nội dung ngoại tuyến thống nhất (Unified SSoT Resolver).
///
/// **Các Bất Biến Cốt Lõi (Invariants):**
/// 1. SSoT Proof: Chỉ trả nội dung khi có đồng thời row `offline_chapters` VÀ payload `installed/` hợp lệ; tuyệt đối không suy luận từ `download_tasks.READY`.
/// 2. P0.1 Exact-Version Selection: Ưu tiên `preferredVersionId`; nếu không có thì áp dụng policy deterministic (`installedAt DESC, chapterVersionId DESC`).
/// 3. P0.4 Synthetic ChapterDetail: Bind chính xác `activeVersion.id == offlineChapter.chapterVersionId`, trích xuất metadata từ canonical manifest.
/// 4. Canonical Page Order: Sắp xếp các trang theo đúng `sortOrder` trong manifest; tuyệt đối không dùng `Directory.listSync()`.
/// 5. Strict Whitelist Novel: Chỉ resolve các ảnh minh họa có trong inventory manifest; tệp ngoại lai bị chặn trong offline mode.
/// 6. Fail-Closed: Mọi hư hỏng payload hoặc sai lệch hash trả về `null` để reader fallback sang online hoặc báo lỗi sạch sẽ.
class OfflineContentResolver {
  final OfflineStorageRepository _repository;
  final OfflineStoragePaths _storagePaths;
  final BundleInstaller _bundleInstaller;

  OfflineContentResolver({
    required OfflineStorageRepository repository,
    required OfflineStoragePaths storagePaths,
    required BundleInstaller bundleInstaller,
  })  : _repository = repository,
        _storagePaths = storagePaths,
        _bundleInstaller = bundleInstaller {
    if (repository.userId != storagePaths.userId || repository.userId != bundleInstaller.userId) {
      throw ArgumentError(
        'Identity mismatch in OfflineContentResolver: repository (${repository.userId}), storagePaths (${storagePaths.userId}), bundleInstaller (${bundleInstaller.userId})',
      );
    }
  }

  String get userId => _repository.userId;


  /// Giải quyết nội dung chương truyện ngoại tuyến.
  /// Trả về null nếu chưa được cài đặt, hoặc payload bị hỏng / không toàn vẹn.
  Future<ResolvedOfflineChapter?> resolveChapter({
    required String chapterId,
    String? preferredVersionId,
  }) async {
    final OfflineChapter? offlineChapter;

    // 1. P0.1 Exact-Version Matching & Deterministic Selection
    if (preferredVersionId != null && preferredVersionId.isNotEmpty) {
      final candidate = await _repository.getOfflineChapter(preferredVersionId);
      if (candidate != null && candidate.chapterId == chapterId) {
        offlineChapter = candidate;
      } else {
        return null;
      }
    } else {
      final candidates = await _repository.getOfflineChaptersByChapterId(chapterId);
      if (candidates.isEmpty) {
        return null;
      }
      // Sắp xếp deterministic: installedAt DESC, sau đó chapterVersionId DESC
      candidates.sort((a, b) {
        final cmp = b.installedAt.compareTo(a.installedAt);
        if (cmp != 0) return cmp;
        return b.chapterVersionId.compareTo(a.chapterVersionId);
      });
      offlineChapter = candidates.first;
    }

    // P0.1: Fail-closed ngay lập tức nếu chapter có deletion tombstone
    final tombstone = await _repository.getTombstone(offlineChapter.chapterVersionId);
    if (tombstone != null) {
      return null;
    }

    // 2. Kiểm tra thư mục cài đặt trên đĩa
    final installedPath = await _storagePaths.getInstalledPathForVersion(offlineChapter.chapterVersionId);
    final installedDir = Directory(installedPath);
    if (!await installedDir.exists()) {
      return null;
    }

    // 3. Xác thực toàn vẹn bằng Canonical Verifier SSoT
    final validation = await _bundleInstaller.verifyInstalledPayload(
      installedDir,
      expectedVersionId: offlineChapter.chapterVersionId,
      expectedChapterId: offlineChapter.chapterId,
      expectedStoryId: offlineChapter.storyId,
      expectedMediaFormat: offlineChapter.mediaFormat,
      verifyFileHashes: true,
    );

    if (!validation.isValid) {
      // Fail-closed khi tệp bị xóa, sửa đổi hoặc sai hash
      return null;
    }

    final manifest = validation.manifest!;
    final files = (manifest['files'] as List<dynamic>?) ?? [];

    // 4. Giải quyết theo định dạng truyền thông
    if (offlineChapter.mediaFormat.toUpperCase() == 'NOVEL') {
      final novelMeta = manifest['novelMetadata'] as Map<String, dynamic>?;
      final contentPath = novelMeta?['contentPath'] as String? ?? 'content.html';
      final htmlFile = File(p.join(installedPath, contentPath));
      if (!await htmlFile.exists()) return null;

      var rawHtml = await htmlFile.readAsString();

      // P1.1 Strict Whitelist cho ảnh minh họa trong manifest
      final localAssetFiles = <String, File>{};
      final allowedIllustrationPaths = <String>{};
      for (final f in files) {
        if (f is Map<String, dynamic>) {
          final relPath = f['path'] as String?;
          final assetId = f['assetId'] as String? ?? relPath;
          if (relPath != null && assetId != null && relPath != contentPath) {
            final absFile = File(p.join(installedPath, relPath));
            localAssetFiles[assetId] = absFile;
            allowedIllustrationPaths.add(absFile.path);
            // Rewrite đường dẫn tương đối trong HTML sang đường dẫn tuyệt đối cục bộ
            rawHtml = rawHtml.replaceAll(relPath, absFile.path);
          }
        }
      }

      final chapterDetail = _buildChapterDetailFromManifest(
        manifest,
        offlineChapter,
        pages: const [],
      );

      return ResolvedOfflineChapter(
        offlineChapter: offlineChapter,
        manifest: manifest,
        installedPath: installedPath,
        chapterDetail: chapterDetail,
        localAssetFiles: localAssetFiles,
        novelHtmlContent: rawHtml,
        allowedIllustrationPaths: allowedIllustrationPaths,
      );
    } else {
      // COMIC / WEBTOON / MANGA:
      // Canonical Page Ordering từ manifest.files sorted by sortOrder
      final pageEntries = files
          .whereType<Map<String, dynamic>>()
          .where((f) => (f['assetType'] as String?) != 'NOVEL_HTML')
          .toList()
        ..sort((a, b) => ((a['sortOrder'] as num?)?.toInt() ?? 0)
            .compareTo((b['sortOrder'] as num?)?.toInt() ?? 0));

      final pages = <ChapterPage>[];
      final localAssetFiles = <String, File>{};

      for (var i = 0; i < pageEntries.length; i++) {
        final entry = pageEntries[i];
        final assetId = entry['assetId'] as String? ?? 'page_$i';
        final relPath = entry['path'] as String?;
        if (relPath == null) continue;

        final absFile = File(p.join(installedPath, relPath));
        localAssetFiles[assetId] = absFile;

        pages.add(ChapterPage(
          assetId: assetId,
          sortOrder: (entry['sortOrder'] as num?)?.toInt() ?? i,
          assetType: entry['assetType'] as String? ?? 'MANGA_PAGE',
          width: (entry['width'] as num?)?.toInt(),
          height: (entry['height'] as num?)?.toInt(),
          storageKey: absFile.path,
        ));
      }

      final chapterDetail = _buildChapterDetailFromManifest(
        manifest,
        offlineChapter,
        pages: pages,
      );

      return ResolvedOfflineChapter(
        offlineChapter: offlineChapter,
        manifest: manifest,
        installedPath: installedPath,
        chapterDetail: chapterDetail,
        localAssetFiles: localAssetFiles,
      );
    }
  }

  /// Tổng hợp ChapterDetail canonical từ manifest và offline chapter (P0.4).
  ChapterDetail _buildChapterDetailFromManifest(
    Map<String, dynamic> manifest,
    OfflineChapter offlineChapter, {
    required List<ChapterPage> pages,
  }) {
    final storyId = (manifest['storyId'] as String?) ?? offlineChapter.storyId;
    final storyTitle = (manifest['storyTitle'] as String?) ?? offlineChapter.storyTitle;
    final mediaFormat = (manifest['mediaFormat'] as String?) ?? offlineChapter.mediaFormat;
    final chapterId = (manifest['chapterId'] as String?) ?? offlineChapter.chapterId;
    final chapterNumber = (manifest['chapterNumber']?.toString()) ?? offlineChapter.chapterNumber;
    final chapterTitle = (manifest['chapterTitle'] as String?) ?? offlineChapter.chapterTitle;
    final versionNumber = (manifest['versionNumber'] as num?)?.toInt() ?? 1;
    final versionType = manifest['versionType'] as String?;
    final language = manifest['language'] as String? ?? 'vi';

    return ChapterDetail(
      story: ChapterStorySummary(
        id: storyId,
        slug: (manifest['storySlug'] as String?) ?? storyId,
        title: storyTitle,
        mediaFormat: mediaFormat,
        visibility: 'PUBLIC',
      ),
      chapter: ChapterHeaderSummary(
        id: chapterId,
        chapterNumber: chapterNumber,
        title: chapterTitle,
        activeVersionId: offlineChapter.chapterVersionId,
        viewsCount: 0,
      ),
      activeVersion: ChapterVersionInfo(
        id: offlineChapter.chapterVersionId,
        versionNumber: versionNumber,
        versionType: versionType,
        language: language,
        isPublished: true,
      ),
      availableVersions: [
        ChapterVersionInfo(
          id: offlineChapter.chapterVersionId,
          versionNumber: versionNumber,
          versionType: versionType,
          language: language,
          isPublished: true,
        ),
      ],
      pages: pages,
      navigation: const ChapterNavigation(),
    );
  }
}
