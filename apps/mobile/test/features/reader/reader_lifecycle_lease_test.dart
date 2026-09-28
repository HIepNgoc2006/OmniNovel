import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/offline/models/offline_chapter.dart';
import 'package:omninovel_mobile/features/offline/services/offline_content_resolver.dart';
import 'package:omninovel_mobile/features/offline/services/reader_lease_manager.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_image_cache_coordinator.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_controller.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_state.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';

class MockChapterRepository extends Mock implements ChapterRepository {}
class MockImageCacheCoordinator extends Mock implements ReaderImageCacheCoordinator {}
class MockOfflineContentResolver extends Mock implements OfflineContentResolver {}

void main() {
  late MockChapterRepository chapterRepo;
  late MockImageCacheCoordinator cacheCoordinator;
  late MockOfflineContentResolver offlineResolver;
  late ReaderLeaseManager leaseManager;

  setUp(() {
    chapterRepo = MockChapterRepository();
    cacheCoordinator = MockImageCacheCoordinator();
    offlineResolver = MockOfflineContentResolver();
    leaseManager = ReaderLeaseManager();
  });

  ResolvedOfflineChapter createDummyResolved({
    required String userId,
    required String chapterVersionId,
    required String chapterId,
  }) {
    final detail = ChapterDetail(
      chapter: ChapterHeaderSummary(id: chapterId, chapterNumber: '1', title: 'Chap $chapterId'),
      story: const ChapterStorySummary(id: 's1', slug: 's1', title: 'Story 1', mediaFormat: 'COMIC'),
      activeVersion: ChapterVersionInfo(id: chapterVersionId, versionNumber: 1),
      pages: const [ChapterPage(assetId: 'a1', sortOrder: 0)],
    );

    return ResolvedOfflineChapter(
      offlineChapter: OfflineChapter(
        userId: userId,
        chapterVersionId: chapterVersionId,
        chapterId: chapterId,
        storyId: 's1',
        storyTitle: 'Story 1',
        chapterNumber: '1',
        mediaFormat: 'COMIC',
        installedDir: 'files/...',
        totalFiles: 1,
        totalBytes: 100,
        installedAt: 1000,
        manifestJson: '{}',
      ),
      manifest: const {},
      installedPath: 'installed/path',
      chapterDetail: detail,
      localAssetFiles: {'a1': File('fake')},
    );
  }

  test('Gate 4B.1: Offline resolver READY acquires lease for exact chapterVersionId', () async {
    const userId = 'user_reader_lease';
    const versionId = 'ver_offline_001';
    const chapterId = 'chap_001';

    final resolved = createDummyResolved(
      userId: userId,
      chapterVersionId: versionId,
      chapterId: chapterId,
    );

    when(() => offlineResolver.resolveChapter(
      chapterId: chapterId,
      preferredVersionId: versionId,
    )).thenAnswer((_) async => resolved);

    final controller = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );

    expect(leaseManager.isLeased(userId, versionId), isFalse);

    await controller.loadChapter(chapterId, versionId: versionId);

    // Verify lease is acquired
    expect(leaseManager.isLeased(userId, versionId), isTrue);
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));
    expect(controller.state.status, equals(ReaderStatus.ready));
    expect(controller.state.transportMode, equals(ReaderTransportMode.offline));

    // Dispose controller releases lease
    controller.dispose();
    expect(leaseManager.isLeased(userId, versionId), isFalse);
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(0));
  });

  test('Gate 4B.2: Switching chapters releases old lease and acquires new lease fail-safely', () async {
    const userId = 'user_reader_lease';
    const version1 = 'ver_1';
    const version2 = 'ver_2';

    final resolved1 = createDummyResolved(
      userId: userId,
      chapterVersionId: version1,
      chapterId: 'chap_1',
    );
    final resolved2 = createDummyResolved(
      userId: userId,
      chapterVersionId: version2,
      chapterId: 'chap_2',
    );

    when(() => offlineResolver.resolveChapter(chapterId: 'chap_1', preferredVersionId: version1))
        .thenAnswer((_) async => resolved1);
    when(() => offlineResolver.resolveChapter(chapterId: 'chap_2', preferredVersionId: version2))
        .thenAnswer((_) async => resolved2);

    final controller = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );

    await controller.loadChapter('chap_1', versionId: version1);
    expect(leaseManager.isLeased(userId, version1), isTrue);
    expect(leaseManager.isLeased(userId, version2), isFalse);

    // Switch to chapter 2
    await controller.loadChapter('chap_2', versionId: version2);
    expect(leaseManager.isLeased(userId, version1), isFalse);
    expect(leaseManager.isLeased(userId, version2), isTrue);

    controller.dispose();
    expect(leaseManager.isLeased(userId, version2), isFalse);
  });

  test('Gate 4B.3: Online chapter does NOT acquire offline lease; two concurrent readers ref-count correctly', () async {
    const userId = 'user_reader_lease';
    const versionId = 'ver_shared';

    final resolved = createDummyResolved(
      userId: userId,
      chapterVersionId: versionId,
      chapterId: 'chap_shared',
    );

    when(() => offlineResolver.resolveChapter(chapterId: 'chap_shared', preferredVersionId: versionId))
        .thenAnswer((_) async => resolved);

    // Controller 1
    final controller1 = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );
    // Controller 2
    final controller2 = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );

    await controller1.loadChapter('chap_shared', versionId: versionId);
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));

    await controller2.loadChapter('chap_shared', versionId: versionId);
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(2));

    controller1.dispose();
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));
    expect(leaseManager.isLeased(userId, versionId), isTrue);

    controller2.dispose();
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(0));
    expect(leaseManager.isLeased(userId, versionId), isFalse);

    // Online reader: offlineResolver trả về null
    when(() => offlineResolver.resolveChapter(chapterId: 'chap_online', preferredVersionId: any(named: 'preferredVersionId')))
        .thenAnswer((_) async => null);

    const onlineDetail = ChapterDetail(
      chapter: ChapterHeaderSummary(id: 'chap_online', chapterNumber: '1', title: 'Online'),
      story: ChapterStorySummary(id: 's1', slug: 's1', title: 'Story', mediaFormat: 'COMIC'),
      activeVersion: ChapterVersionInfo(id: 'ver_online', versionNumber: 1),
      pages: [],
    );
    when(() => chapterRepo.getChapterDetail('chap_online', versionId: any(named: 'versionId')))
        .thenAnswer((_) async => onlineDetail);

    final onlineController = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );

    await onlineController.loadChapter('chap_online');
    expect(onlineController.state.transportMode, equals(ReaderTransportMode.online));
    expect(leaseManager.getActiveTokensForUser(userId), isEmpty);

    onlineController.dispose();
  });

  test('Gate 5B: Reader offline READY updates last_read_at on exact chapterVersionId', () async {
    const userId = 'user_reader_lease';
    const versionId = 'ver_lru_wired';
    const chapterId = 'chap_lru';

    final resolved = createDummyResolved(
      userId: userId,
      chapterVersionId: versionId,
      chapterId: chapterId,
    );

    when(() => offlineResolver.resolveChapter(
      chapterId: chapterId,
      preferredVersionId: versionId,
    )).thenAnswer((_) async => resolved);

    when(() => offlineResolver.updateLastReadAt(
      versionId,
      timestamp: any(named: 'timestamp'),
    )).thenAnswer((_) async {});

    final controller = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );

    await controller.loadChapter(chapterId, versionId: versionId);

    expect(controller.state.transportMode, equals(ReaderTransportMode.offline));
    expect(controller.state.status, equals(ReaderStatus.ready));

    // Verify updateLastReadAt was called with exact chapterVersionId
    verify(() => offlineResolver.updateLastReadAt(
      versionId,
      timestamp: any(named: 'timestamp'),
    )).called(1);

    controller.dispose();
  });
}
