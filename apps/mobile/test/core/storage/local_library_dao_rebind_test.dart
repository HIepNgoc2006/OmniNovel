import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';
import 'package:omninovel_mobile/core/claim/models/pending_guest_claim.dart';
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

  const guestScope = 'guest:profile-uuid-1234';
  const targetScope = 'account:user-uuid-5678';
  const otherScope = 'guest:profile-uuid-9999';
  const claimId = 'claim-uuid-abcd-ef01';

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('omninovel_dao_rebind_test_');
    dbPath = p.join(tempDir.path, 'dao_rebind_test.db');
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

  group('Task 2: LocalLibraryDao Rebind & Authoritative Reconciliation (Task 2 GREEN)', () {
    test('hasGuestData should return true when any guest table has data and false when empty', () async {
      // 1. Initially empty
      expect(await dao.hasGuestData(guestScope), isFalse);

      // 2. Only bookmark
      final bookmark = LocalBookmark(
        ownerScope: guestScope,
        storyId: 'story-1',
        title: 'Story 1',
        createdAt: DateTime.now().toUtc(),
      );
      await dao.saveBookmark(bookmark);
      expect(await dao.hasGuestData(guestScope), isTrue);

      // Clean up bookmark
      await dao.deleteBookmark(ownerScope: guestScope, storyId: 'story-1');
      expect(await dao.hasGuestData(guestScope), isFalse);

      // 3. Only progress
      final progress = LocalReadingProgress(
        ownerScope: guestScope,
        storyId: 'story-2',
        chapterId: 'chap-2',
        progressPercentage: 50.0,
        scrollPosition: 120.0,
        updatedAt: DateTime.now().toUtc(),
        deviceTimestamp: DateTime.now().toUtc(),
      );
      await dao.saveProgress(progress);
      expect(await dao.hasGuestData(guestScope), isTrue);

      // Clean up progress
      await dao.deleteStoryReadingState(ownerScope: guestScope, storyId: 'story-2');
      expect(await dao.hasGuestData(guestScope), isFalse);

      // 4. Only history
      final history = LocalReadingHistory(
        ownerScope: guestScope,
        storyId: 'story-3',
        chapterId: 'chap-3',
        storyTitle: 'Story 3',
        chapterNumber: '3',
        progressPercentage: 100.0,
        lastReadAt: DateTime.now().toUtc(),
      );
      await dao.saveHistory(history);
      expect(await dao.hasGuestData(guestScope), isTrue);
    });

    test('getClaimedStoryIds should extract distinct story IDs from bookmarks, progress, and history', () async {
      // Story A in bookmarks and progress
      await dao.saveBookmark(LocalBookmark(
        ownerScope: guestScope,
        storyId: 'story-A',
        title: 'Story A',
        createdAt: DateTime.now().toUtc(),
      ));
      await dao.saveProgress(LocalReadingProgress(
        ownerScope: guestScope,
        storyId: 'story-A',
        chapterId: 'chap-A1',
        progressPercentage: 20.0,
        scrollPosition: 0.0,
        updatedAt: DateTime.now().toUtc(),
        deviceTimestamp: DateTime.now().toUtc(),
      ));

      // Story B only in history
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: guestScope,
        storyId: 'story-B',
        chapterId: 'chap-B1',
        storyTitle: 'Story B',
        chapterNumber: '1',
        progressPercentage: 100.0,
        lastReadAt: DateTime.now().toUtc(),
      ));

      // Story C belongs to otherScope (must NOT be returned)
      await dao.saveBookmark(LocalBookmark(
        ownerScope: otherScope,
        storyId: 'story-C',
        title: 'Story C',
        createdAt: DateTime.now().toUtc(),
      ));

      final claimedIds = await dao.getClaimedStoryIds(guestScope);
      expect(claimedIds, containsAll({'story-A', 'story-B'}));
      expect(claimedIds.length, equals(2));
      expect(claimedIds.contains('story-C'), isFalse);
    });

    test('rebindScope should merge bookmarks additively even if story is in tombstonedStoryIds', () async {
      // Guest bookmark
      await dao.saveBookmark(LocalBookmark(
        ownerScope: guestScope,
        storyId: 'story-tombstoned',
        title: 'Tombstoned Story',
        createdAt: DateTime.fromMillisecondsSinceEpoch(1700000000000, isUtc: true),
      ));

      // Existing target bookmark
      await dao.saveBookmark(LocalBookmark(
        ownerScope: targetScope,
        storyId: 'story-existing',
        title: 'Existing Account Story',
        createdAt: DateTime.fromMillisecondsSinceEpoch(1700000001000, isUtc: true),
      ));

      // Recovery journal record
      final db = offlineDb.database;
      await db.insert('guest_claim_recovery_journal', {
        'claim_id': claimId,
        'user_id': 'user-uuid-5678',
        'guest_profile_id': 'profile-uuid-1234',
        'expected_state_fingerprint': 'a' * 64,
        'conflict_decisions': '{}',
        'phase': 'committing',
        'preview_data': null,
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      final finalization = GuestClaimFinalizationData(
        tombstonedStoryIds: ['story-tombstoned'],
        finalizedProgress: [],
        finalizedChapterReadStates: [],
      );

      await dao.rebindScope(
        sourceScope: guestScope,
        targetScope: targetScope,
        claimId: claimId,
        finalization: finalization,
      );

      // Both bookmarks must exist in targetScope
      final targetBookmarks = await dao.getBookmarks(ownerScope: targetScope);
      expect(targetBookmarks.length, equals(2));
      expect(targetBookmarks.any((b) => b.storyId == 'story-tombstoned'), isTrue);
      expect(targetBookmarks.any((b) => b.storyId == 'story-existing'), isTrue);

      // Guest partition must be purged
      expect(await dao.getBookmarks(ownerScope: guestScope), isEmpty);

      // Journal entry must be deleted
      final remainingJournal = await db.query(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: [claimId],
      );
      expect(remainingJournal, isEmpty);
    });

    test('rebindScope should reconcile 12-column progress round-trip and history with metadata', () async {
      // 1. Seed guest data
      await dao.saveProgress(LocalReadingProgress(
        ownerScope: guestScope,
        storyId: 'story-comic',
        chapterId: 'chap-10',
        chapterVersionId: 'ver-10',
        readingMode: 'PAGED',
        progressPercentage: 55.0,
        scrollPosition: 0.0,
        pageIndex: 12,
        anchorBlockId: 'block-1',
        textOffset: 42,
        updatedAt: DateTime.fromMillisecondsSinceEpoch(1700000010000, isUtc: true),
        deviceTimestamp: DateTime.fromMillisecondsSinceEpoch(1700000010000, isUtc: true),
      ));

      await dao.saveHistory(LocalReadingHistory(
        ownerScope: guestScope,
        storyId: 'story-comic',
        chapterId: 'chap-10',
        chapterVersionId: 'ver-10',
        storyTitle: 'Comic Masterpiece',
        storySlug: 'comic-masterpiece',
        storyCoverUrl: 'https://img.example.com/cover.jpg',
        chapterNumber: '10',
        chapterTitle: 'The Awakening',
        progressPercentage: 55.0,
        lastReadAt: DateTime.fromMillisecondsSinceEpoch(1700000010000, isUtc: true),
      ));

      // Seed journal
      final db = offlineDb.database;
      await db.insert('guest_claim_recovery_journal', {
        'claim_id': claimId,
        'user_id': 'user-uuid-5678',
        'guest_profile_id': 'profile-uuid-1234',
        'expected_state_fingerprint': 'b' * 64,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': null,
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      // Authoritative finalization snapshot with server updated progress
      final finalization = GuestClaimFinalizationData(
        tombstonedStoryIds: [],
        finalizedProgress: [
          ClaimFinalizedProgressItem(
            storyId: 'story-comic',
            chapterId: 'chap-10',
            chapterVersionId: 'ver-10',
            readingMode: ReadingMode.paged,
            pageIndex: 15,
            scrollPosition: 0.0,
            progressPercentage: 75.0,
            anchorBlockId: 'block-2',
            textOffset: 88,
            updatedAt: '2026-10-14T10:00:00.000Z',
          ),
        ],
        finalizedChapterReadStates: [
          ClaimFinalizedChapterReadStateItem(
            storyId: 'story-comic',
            chapterId: 'chap-10',
            chapterVersionId: 'ver-10',
            progressPercentage: 100.0,
            completedAt: '2026-10-14T10:00:00.000Z',
            lastReadAt: '2026-10-14T10:00:00.000Z',
          ),
        ],
      );

      await dao.rebindScope(
        sourceScope: guestScope,
        targetScope: targetScope,
        claimId: claimId,
        finalization: finalization,
      );

      // Verify 12-column progress in targetScope
      final targetProgress = await dao.getProgress(
        ownerScope: targetScope,
        storyId: 'story-comic',
      );
      expect(targetProgress, isNotNull);
      expect(targetProgress!.storyId, equals('story-comic'));
      expect(targetProgress.chapterId, equals('chap-10'));
      expect(targetProgress.readingMode, equals('PAGED'));
      expect(targetProgress.pageIndex, equals(15));
      expect(targetProgress.progressPercentage, equals(75.0));
      expect(targetProgress.anchorBlockId, equals('block-2'));
      expect(targetProgress.textOffset, equals(88));
      expect(targetProgress.updatedAt.isUtc, isTrue);
      expect(targetProgress.deviceTimestamp.isUtc, isTrue);

      // Verify history in targetScope retained metadata from guest record
      final targetHistory = await dao.getHistoryItem(
        ownerScope: targetScope,
        storyId: 'story-comic',
        chapterId: 'chap-10',
      );
      expect(targetHistory, isNotNull);
      expect(targetHistory!.storyTitle, equals('Comic Masterpiece'));
      expect(targetHistory.storySlug, equals('comic-masterpiece'));
      expect(targetHistory.storyCoverUrl, equals('https://img.example.com/cover.jpg'));
      expect(targetHistory.chapterNumber, equals('10'));
      expect(targetHistory.chapterTitle, equals('The Awakening'));
      expect(targetHistory.progressPercentage, equals(100.0));

      // Guest partition completely purged
      expect(await dao.getProgress(ownerScope: guestScope, storyId: 'story-comic'), isNull);
      expect(await dao.getHistory(ownerScope: guestScope), isEmpty);
    });

    test('rebindScope should filter out tombstoned reading state while keeping bookmark', () async {
      const tombstonedStory = 'story-tombstoned-novel';
      await dao.saveBookmark(LocalBookmark(
        ownerScope: guestScope,
        storyId: tombstonedStory,
        title: 'Tombstoned Novel',
        createdAt: DateTime.now().toUtc(),
      ));
      await dao.saveProgress(LocalReadingProgress(
        ownerScope: guestScope,
        storyId: tombstonedStory,
        chapterId: 'chap-1',
        progressPercentage: 40.0,
        scrollPosition: 0.0,
        updatedAt: DateTime.now().toUtc(),
        deviceTimestamp: DateTime.now().toUtc(),
      ));
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: guestScope,
        storyId: tombstonedStory,
        chapterId: 'chap-1',
        storyTitle: 'Tombstoned Novel',
        chapterNumber: '1',
        progressPercentage: 40.0,
        lastReadAt: DateTime.now().toUtc(),
      ));

      final finalization = GuestClaimFinalizationData(
        tombstonedStoryIds: [tombstonedStory],
        finalizedProgress: [],
        finalizedChapterReadStates: [],
      );

      await dao.rebindScope(
        sourceScope: guestScope,
        targetScope: targetScope,
        claimId: claimId,
        finalization: finalization,
      );

      // Bookmark is kept
      final targetBm = await dao.getBookmark(ownerScope: targetScope, storyId: tombstonedStory);
      expect(targetBm, isNotNull);

      // Reading progress and history must NOT exist in targetScope (anti-resurrection)
      final targetProg = await dao.getProgress(ownerScope: targetScope, storyId: tombstonedStory);
      expect(targetProg, isNull);

      final targetHist = await dao.getHistory(ownerScope: targetScope);
      expect(targetHist, isEmpty);
    });

    test('rebindScope should atomically rollback all changes if exception occurs during rebind', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: guestScope,
        storyId: 'story-rollback',
        title: 'Rollback Story',
        createdAt: DateTime.now().toUtc(),
      ));

      final db = offlineDb.database;
      await db.insert('guest_claim_recovery_journal', {
        'claim_id': claimId,
        'user_id': 'user-uuid-5678',
        'guest_profile_id': 'profile-uuid-1234',
        'expected_state_fingerprint': 'c' * 64,
        'conflict_decisions': '{}',
        'phase': 'committing',
        'preview_data': null,
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      // Rebind with onBeforeCommitHook that throws to verify atomic rollback
      await expectLater(
        dao.rebindScope(
          sourceScope: guestScope,
          targetScope: targetScope,
          claimId: claimId,
          finalization: const GuestClaimFinalizationData(
            tombstonedStoryIds: [],
            finalizedProgress: [],
            finalizedChapterReadStates: [],
          ),
          onBeforeCommitHook: () async {
            throw Exception('Simulated crash during rebind');
          },
        ),
        throwsA(isA<Exception>()),
      );

      // Guest bookmark must still exist (100% preserved)
      final guestBm = await dao.getBookmark(ownerScope: guestScope, storyId: 'story-rollback');
      expect(guestBm, isNotNull);

      // Target bookmark must NOT exist
      final targetBm = await dao.getBookmark(ownerScope: targetScope, storyId: 'story-rollback');
      expect(targetBm, isNull);

      // Journal entry must still exist
      final remainingJournal = await db.query(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: [claimId],
      );
      expect(remainingJournal, isNotEmpty);
    });

    test('rebindScope should handle legacy claim with finalization == null safely (bookmark only)', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: guestScope,
        storyId: 'story-legacy',
        title: 'Legacy Story',
        createdAt: DateTime.now().toUtc(),
      ));

      await dao.rebindScope(
        sourceScope: guestScope,
        targetScope: targetScope,
        claimId: claimId,
        finalization: null, // Legacy server without finalization_data
      );

      // Bookmark merged into target
      final targetBm = await dao.getBookmark(ownerScope: targetScope, storyId: 'story-legacy');
      expect(targetBm, isNotNull);

      // Guest partition purged when only bookmarks existed
      expect(await dao.hasGuestData(guestScope), isFalse);
    });

    test('rebindScope should preserve guest reading progress, history and recovery journal when finalization == null (non-destructive legacy fallback)', () async {
      // Seed guest bookmark, progress and history
      await dao.saveBookmark(LocalBookmark(
        ownerScope: guestScope,
        storyId: 'story-legacy-preserve',
        title: 'Legacy Preserve Story',
        createdAt: DateTime.now().toUtc(),
      ));

      await dao.saveProgress(LocalReadingProgress(
        ownerScope: guestScope,
        storyId: 'story-legacy-preserve',
        chapterId: 'chap-1',
        progressPercentage: 50.0,
        scrollPosition: 100.0,
        updatedAt: DateTime.now().toUtc(),
        deviceTimestamp: DateTime.now().toUtc(),
      ));

      await dao.saveHistory(LocalReadingHistory(
        ownerScope: guestScope,
        storyId: 'story-legacy-preserve',
        chapterId: 'chap-1',
        storyTitle: 'Legacy Preserve Story',
        chapterNumber: '1',
        progressPercentage: 50.0,
        lastReadAt: DateTime.now().toUtc(),
      ));

      final db = offlineDb.database;
      await db.insert('guest_claim_recovery_journal', {
        'claim_id': claimId,
        'user_id': 'user-uuid-5678',
        'guest_profile_id': 'profile-uuid-1234',
        'expected_state_fingerprint': 'e' * 64,
        'conflict_decisions': '{}',
        'phase': 'committing',
        'preview_data': null,
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      // Call rebindScope with finalization == null
      await dao.rebindScope(
        sourceScope: guestScope,
        targetScope: targetScope,
        claimId: claimId,
        finalization: null,
      );

      // 1. Bookmark is merged into target
      final targetBm = await dao.getBookmark(ownerScope: targetScope, storyId: 'story-legacy-preserve');
      expect(targetBm, isNotNull);

      // 2. Guest bookmark is removed
      final guestBm = await dao.getBookmark(ownerScope: guestScope, storyId: 'story-legacy-preserve');
      expect(guestBm, isNull);

      // 3. Guest reading progress and history are PRESERVED 100% (non-destructive)
      final guestProg = await dao.getProgress(ownerScope: guestScope, storyId: 'story-legacy-preserve');
      expect(guestProg, isNotNull);
      expect(guestProg!.progressPercentage, equals(50.0));

      final guestHist = await dao.getHistoryItem(
        ownerScope: guestScope,
        storyId: 'story-legacy-preserve',
        chapterId: 'chap-1',
      );
      expect(guestHist, isNotNull);

      // 4. Recovery journal is PRESERVED so coordinator can safely inspect/retry
      final journalRows = await db.query(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: [claimId],
      );
      expect(journalRows, isNotEmpty);
    });
  });
}
