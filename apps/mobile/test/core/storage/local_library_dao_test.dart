import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;
  late OfflineDatabase offlineDb;
  late LocalLibraryDao dao;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('omninovel_local_dao_test_');
    dbPath = p.join(tempDir.path, 'dao_test.db');
    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: dbPath,
      databaseFactory: databaseFactoryFfi,
    );
    dao = LocalLibraryDao(offlineDatabase: offlineDb);
  });

  tearDown(() async {
    try {
      if (offlineDb.isInitialized) {
        await offlineDb.database.close();
      }
      await databaseFactoryFfi.deleteDatabase(dbPath);
    } catch (_) {}
    try {
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    } catch (_) {}
  });

  group('7A.5a: LocalLibraryDao Unit & Invariants Test Suite', () {
    test('SQLite row <-> Dart model round-trip with full paged & novel fields and timestamp semantics', () async {
      final now = DateTime.fromMillisecondsSinceEpoch(1728100000000, isUtc: true);
      final deviceTime = DateTime.fromMillisecondsSinceEpoch(1728100000500, isUtc: true);

      // 1. Paged Manga Progress round-trip (pageIndex 27, scrollPosition 0)
      final pagedProgress = LocalReadingProgress(
        ownerScope: 'guest:profile-1',
        storyId: 'story-manga-1',
        chapterId: 'chap-1',
        chapterVersionId: 'ver-1',
        readingMode: 'MANGA_PAGED',
        progressPercentage: 45.5,
        scrollPosition: 0.0,
        pageIndex: 27,
        anchorBlockId: null,
        textOffset: null,
        updatedAt: now,
        deviceTimestamp: deviceTime,
      );

      await dao.saveProgress(pagedProgress);
      final retrievedPaged = await dao.getProgress(
        ownerScope: 'guest:profile-1',
        storyId: 'story-manga-1',
      );

      expect(retrievedPaged, isNotNull);
      expect(retrievedPaged!.ownerScope, 'guest:profile-1');
      expect(retrievedPaged.storyId, 'story-manga-1');
      expect(retrievedPaged.readingMode, 'MANGA_PAGED');
      expect(retrievedPaged.pageIndex, 27);
      expect(retrievedPaged.scrollPosition, 0.0);
      expect(retrievedPaged.progressPercentage, 45.5);
      expect(retrievedPaged.updatedAt.millisecondsSinceEpoch, 1728100000000);
      expect(retrievedPaged.deviceTimestamp.millisecondsSinceEpoch, 1728100000500);

      // 2. Novel Reading Progress round-trip (anchorBlockId, textOffset, scrollPosition)
      final novelProgress = LocalReadingProgress(
        ownerScope: 'guest:profile-1',
        storyId: 'story-novel-1',
        chapterId: 'chap-novel-1',
        chapterVersionId: null,
        readingMode: 'NOVEL',
        progressPercentage: 88.0,
        scrollPosition: 3420.5,
        pageIndex: 1,
        anchorBlockId: 'block_anchor_42',
        textOffset: 120,
        updatedAt: now,
        deviceTimestamp: deviceTime,
      );

      await dao.saveProgress(novelProgress);
      final retrievedNovel = await dao.getProgress(
        ownerScope: 'guest:profile-1',
        storyId: 'story-novel-1',
      );

      expect(retrievedNovel, isNotNull);
      expect(retrievedNovel!.anchorBlockId, 'block_anchor_42');
      expect(retrievedNovel.textOffset, 120);
      expect(retrievedNovel.scrollPosition, 3420.5);
      expect(retrievedNovel.pageIndex, 1);
    });

    test('Bookmark CRUD maintains scope isolation and ordering by created_at DESC', () async {
      final t1 = DateTime.fromMillisecondsSinceEpoch(1728100000000, isUtc: true);
      final t2 = DateTime.fromMillisecondsSinceEpoch(1728100010000, isUtc: true);

      final bm1 = LocalBookmark(
        ownerScope: 'guest:alpha',
        storyId: 'story-1',
        title: 'Story One',
        slug: 'story-one',
        coverUrl: '/cover1.jpg',
        createdAt: t1,
      );
      final bm2 = LocalBookmark(
        ownerScope: 'guest:alpha',
        storyId: 'story-2',
        title: 'Story Two',
        slug: 'story-two',
        coverUrl: '/cover2.jpg',
        createdAt: t2,
      );

      await dao.saveBookmark(bm1);
      await dao.saveBookmark(bm2);

      expect(await dao.isBookmarked(ownerScope: 'guest:alpha', storyId: 'story-1'), isTrue);
      expect(await dao.isBookmarked(ownerScope: 'guest:alpha', storyId: 'story-999'), isFalse);

      final bookmarks = await dao.getBookmarks(ownerScope: 'guest:alpha');
      expect(bookmarks.length, 2);
      expect(bookmarks[0].storyId, 'story-2'); // t2 is newer
      expect(bookmarks[1].storyId, 'story-1');

      await dao.deleteBookmark(ownerScope: 'guest:alpha', storyId: 'story-1');
      expect(await dao.isBookmarked(ownerScope: 'guest:alpha', storyId: 'story-1'), isFalse);
      final remaining = await dao.getBookmarks(ownerScope: 'guest:alpha');
      expect(remaining.length, 1);
      expect(remaining.first.storyId, 'story-2');
    });

    test('Reading history preserves monotonic MAX and calculates readChapterIds with threshold >= 80%', () async {
      final t1 = DateTime.fromMillisecondsSinceEpoch(1728100000000, isUtc: true);
      final t2 = DateTime.fromMillisecondsSinceEpoch(1728100020000, isUtc: true);

      // User reaches 95% on chapter 1
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:beta',
        storyId: 'story-manga',
        chapterId: 'chap-1',
        chapterVersionId: 'v1',
        storyTitle: 'Manga Solo',
        storySlug: 'manga-solo',
        storyCoverUrl: '/cover.png',
        chapterNumber: '1',
        chapterTitle: 'Khởi đầu',
        progressPercentage: 95.0,
        lastReadAt: t1,
      ));

      var readIds = await dao.getReadChapterIds(ownerScope: 'guest:beta', storyId: 'story-manga');
      expect(readIds, contains('chap-1'));

      // User rereads chapter 1 and leaves at 10%
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:beta',
        storyId: 'story-manga',
        chapterId: 'chap-1',
        chapterVersionId: 'v1',
        storyTitle: 'Manga Solo',
        storySlug: 'manga-solo',
        storyCoverUrl: '/cover.png',
        chapterNumber: '1',
        chapterTitle: 'Khởi đầu',
        progressPercentage: 10.0,
        lastReadAt: t2,
      ));

      final hist = await dao.getHistoryItem(
        ownerScope: 'guest:beta',
        storyId: 'story-manga',
        chapterId: 'chap-1',
      );
      // Invariant 5: History progress remains monotonic MAX (95%)
      expect(hist!.progressPercentage, 95.0);
      expect(hist.lastReadAt.millisecondsSinceEpoch, t2.millisecondsSinceEpoch);

      // Invariant 5: Chapter still marked as read (>= 80%)
      readIds = await dao.getReadChapterIds(ownerScope: 'guest:beta', storyId: 'story-manga');
      expect(readIds, contains('chap-1'));

      // Reading chapter 2 only to 50%
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:beta',
        storyId: 'story-manga',
        chapterId: 'chap-2',
        chapterVersionId: 'v1',
        storyTitle: 'Manga Solo',
        storySlug: 'manga-solo',
        storyCoverUrl: '/cover.png',
        chapterNumber: '2',
        chapterTitle: 'Thử thách',
        progressPercentage: 50.0,
        lastReadAt: t2,
      ));

      readIds = await dao.getReadChapterIds(ownerScope: 'guest:beta', storyId: 'story-manga');
      expect(readIds, contains('chap-1'));
      expect(readIds, isNot(contains('chap-2')));
    });

    test('Two-profile isolation: identical story IDs are completely isolated across all operations', () async {
      final now = DateTime.now().toUtc();

      // Guest A data
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:profile-A',
        storyId: 'story-shared-id',
        title: 'Story of Profile A',
        createdAt: now,
      ));
      await dao.saveProgress(LocalReadingProgress(
        ownerScope: 'guest:profile-A',
        storyId: 'story-shared-id',
        chapterId: 'chap-A',
        progressPercentage: 20.0,
        scrollPosition: 100.0,
        pageIndex: 5,
        updatedAt: now,
        deviceTimestamp: now,
      ));
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:profile-A',
        storyId: 'story-shared-id',
        chapterId: 'chap-A',
        storyTitle: 'Story of Profile A',
        chapterNumber: '1',
        progressPercentage: 20.0,
        lastReadAt: now,
      ));

      // Guest B data (same story ID)
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:profile-B',
        storyId: 'story-shared-id',
        title: 'Story of Profile B',
        createdAt: now,
      ));
      await dao.saveProgress(LocalReadingProgress(
        ownerScope: 'guest:profile-B',
        storyId: 'story-shared-id',
        chapterId: 'chap-B',
        progressPercentage: 90.0,
        scrollPosition: 900.0,
        pageIndex: 40,
        updatedAt: now,
        deviceTimestamp: now,
      ));
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:profile-B',
        storyId: 'story-shared-id',
        chapterId: 'chap-B',
        storyTitle: 'Story of Profile B',
        chapterNumber: '2',
        progressPercentage: 90.0,
        lastReadAt: now,
      ));

      // Verify separate values
      final progA = await dao.getProgress(ownerScope: 'guest:profile-A', storyId: 'story-shared-id');
      final progB = await dao.getProgress(ownerScope: 'guest:profile-B', storyId: 'story-shared-id');
      expect(progA!.chapterId, 'chap-A');
      expect(progB!.chapterId, 'chap-B');

      // Delete bookmark on Profile A only
      await dao.deleteBookmark(ownerScope: 'guest:profile-A', storyId: 'story-shared-id');
      expect(await dao.isBookmarked(ownerScope: 'guest:profile-A', storyId: 'story-shared-id'), isFalse);
      expect(await dao.isBookmarked(ownerScope: 'guest:profile-B', storyId: 'story-shared-id'), isTrue);

      // Delete history on Profile A only: Invariant: deletes BOTH history AND progress, leaves bookmark intact
      await dao.deleteStoryHistory(ownerScope: 'guest:profile-A', storyId: 'story-shared-id');
      final histA = await dao.getHistory(ownerScope: 'guest:profile-A');
      final histB = await dao.getHistory(ownerScope: 'guest:profile-B');
      expect(histA, isEmpty);
      expect(histB.length, 1);
      expect(histB.first.chapterId, 'chap-B');

      // Progress for Profile A is deleted, Profile B progress is completely untouched
      expect(await dao.getProgress(ownerScope: 'guest:profile-A', storyId: 'story-shared-id'), isNull);
      final remainingProgB = await dao.getProgress(ownerScope: 'guest:profile-B', storyId: 'story-shared-id');
      expect(remainingProgB, isNotNull);
      expect(remainingProgB!.chapterId, 'chap-B');

      // Clear all history on Profile B: deletes BOTH history and progress, leaves bookmarks intact
      await dao.clearAllHistory(ownerScope: 'guest:profile-B');
      expect(await dao.getHistory(ownerScope: 'guest:profile-B'), isEmpty);
      expect(await dao.getProgress(ownerScope: 'guest:profile-B', storyId: 'story-shared-id'), isNull);
      expect(await dao.isBookmarked(ownerScope: 'guest:profile-B', storyId: 'story-shared-id'), isTrue);
    });

    test('Atomic reading session: atomically commits progress and history with monotonic max', () async {
      final now = DateTime.now().toUtc();

      final progress = LocalReadingProgress(
        ownerScope: 'guest:atomic',
        storyId: 'story-atom',
        chapterId: 'chap-1',
        progressPercentage: 85.0,
        scrollPosition: 1200.0,
        pageIndex: 12,
        updatedAt: now,
        deviceTimestamp: now,
      );

      final history = LocalReadingHistory(
        ownerScope: 'guest:atomic',
        storyId: 'story-atom',
        chapterId: 'chap-1',
        storyTitle: 'Atomic Story',
        chapterNumber: '1',
        progressPercentage: 85.0,
        lastReadAt: now,
      );

      await dao.recordReadingSession(progress: progress, history: history);

      final savedProgress = await dao.getProgress(ownerScope: 'guest:atomic', storyId: 'story-atom');
      final savedHistory = await dao.getHistoryItem(
        ownerScope: 'guest:atomic',
        storyId: 'story-atom',
        chapterId: 'chap-1',
      );

      expect(savedProgress, isNotNull);
      expect(savedProgress!.progressPercentage, 85.0);
      expect(savedHistory, isNotNull);
      expect(savedHistory!.progressPercentage, 85.0);
    });

    test('Atomic reading session rollback: rolls back BOTH progress and history if transaction fails', () async {
      final now = DateTime.now().toUtc();

      final progress = LocalReadingProgress(
        ownerScope: 'guest:rollback',
        storyId: 'story-fail',
        chapterId: 'chap-fail-1',
        progressPercentage: 50.0,
        scrollPosition: 500.0,
        pageIndex: 5,
        updatedAt: now,
        deviceTimestamp: now,
      );

      final history = LocalReadingHistory(
        ownerScope: 'guest:rollback',
        storyId: 'story-fail',
        chapterId: 'chap-fail-1',
        storyTitle: 'Rollback Story',
        chapterNumber: '1',
        progressPercentage: 50.0,
        lastReadAt: now,
      );

      expect(
        () async => await dao.recordReadingSession(
          progress: progress,
          history: history,
          onBeforeCommitHook: () async {
            throw Exception('Simulated transaction mid-stream disk failure');
          },
        ),
        throwsA(isA<Exception>()),
      );

      // Verify that progress was NOT committed
      final savedProgress = await dao.getProgress(
        ownerScope: 'guest:rollback',
        storyId: 'story-fail',
      );
      expect(savedProgress, isNull);

      // Verify that history was NOT committed
      final savedHistory = await dao.getHistoryItem(
        ownerScope: 'guest:rollback',
        storyId: 'story-fail',
        chapterId: 'chap-fail-1',
      );
      expect(savedHistory, isNull);
    });
  });
}
