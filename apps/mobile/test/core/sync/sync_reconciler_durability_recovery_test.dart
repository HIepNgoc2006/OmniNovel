import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/reconciler/mock_sync_transport.dart';
import 'package:omninovel_mobile/core/sync/reconciler/offline_reconciler_state.dart';
import 'package:omninovel_mobile/core/sync/reconciler/offline_sync_reconciler.dart';
import 'package:omninovel_mobile/core/sync/storage/sync_storage_dal.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'sync_test_helpers.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;
  late OfflineDatabase offlineDb;
  late SyncStorageDal dal;
  late ConfigurableMockSyncTransport transport;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('sync_stage2a_durability_');
    dbPath = p.join(tempDir.path, 'stage2a_reconciler.db');
    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: dbPath,
      databaseFactory: databaseFactoryFfi,
    );
    dal = SyncStorageDal(offlineDatabase: offlineDb);
    transport = ConfigurableMockSyncTransport();
  });

  tearDown(() async {
    try {
      if (offlineDb.isInitialized) {
        await offlineDb.database.close();
      }
    } catch (_) {}
    try {
      await databaseFactoryFfi.deleteDatabase(dbPath);
    } catch (_) {}
    try {
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    } catch (_) {}
  });

  group('Phase 7C.4 Stage 2A — Task C: SQLite Atomicity & Recovery', () {
    const scopeA = 'account:user-stage2a-alpha';
    const scopeB = 'account:user-stage2a-beta';
    final admissionA = testAccountAdmission(scopeA);
    final admissionB = testAccountAdmission(scopeB);

    test('1. Pending mutations are strictly preserved in SQLite when network fails', () async {
      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
      );

      // Enqueue 2 pending mutations via putBookmarkWithMutation
      await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(
          ownerScope: scopeA,
          storyId: 'story-dur-01',
          title: 'Story 01',
          createdAt: DateTime.now().toUtc(),
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'mut-dur-01',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-dur-01',
          operation: SyncOperation.upsert,
          baseServerRevision: '10',
          payload: const {'storyId': 'story-dur-01'},
        ),
        admission: admissionA,
      );

      await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(
          ownerScope: scopeA,
          storyId: 'story-dur-02',
          title: 'Story 02',
          createdAt: DateTime.now().toUtc(),
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'mut-dur-02',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-dur-02',
          operation: SyncOperation.upsert,
          baseServerRevision: '10',
          payload: const {'storyId': 'story-dur-02'},
        ),
        admission: admissionA,
      );

      // Cấu hình mock transport ném lỗi mạng
      transport.shouldFailTransiently = true;
      transport.transientFailureCount = 5;

      final cycleResult = await reconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: admissionA,
      );

      expect(cycleResult.finalState, OfflineReconcilerState.retryBackoff);
      expect(cycleResult.mutationsPushed, 0);

      // Pending mutations trong SQLite vẫn nguyên vẹn 2 bản ghi
      final remaining = await dal.getPendingMutations(scopeA);
      expect(remaining.length, 2);
      expect(remaining[0].mutationId, 'mut-dur-01');
      expect(remaining[0].retryCount, 1);
      expect(remaining[1].mutationId, 'mut-dur-02');
      expect(remaining[1].retryCount, 1);
    });

    test('2. FIFO sequence_no preserves strict monotonically increasing order', () async {
      final mut1 = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'fifo-mut-01',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-fifo-01',
          operation: SyncOperation.upsert,
          baseServerRevision: '10',
          payload: const {'storyId': 'story-fifo-01'},
        ),
        admission: admissionA,
      );

      final mut2 = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'fifo-mut-02',
          clientId: kTestClientId,
          domain: SyncDomain.progress,
          entityId: 'story-fifo-01',
          operation: SyncOperation.upsert,
          baseServerRevision: '10',
          payload: const {'storyId': 'story-fifo-01', 'pageIndex': 10},
        ),
        admission: admissionA,
      );

      final mut3 = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'fifo-mut-03',
          clientId: kTestClientId,
          domain: SyncDomain.preference,
          entityId: 'reader_theme',
          operation: SyncOperation.upsert,
          baseServerRevision: '10',
          payload: const {'key': 'reader_theme', 'value': 'dark'},
        ),
        admission: admissionA,
      );

      expect(mut1.sequenceNo, 1);
      expect(mut2.sequenceNo, 2);
      expect(mut3.sequenceNo, 3);

      final fetched = await dal.getPendingMutations(scopeA);
      expect(fetched.map((m) => m.sequenceNo).toList(), [1, 2, 3]);
      expect(fetched.map((m) => m.mutationId).toList(), [
        'fifo-mut-01',
        'fifo-mut-02',
        'fifo-mut-03',
      ]);
    });

    test('3. Quarantine retains full original user payload upon permanent rejection', () async {
      const originalPayload = {
        'storyId': 'story-quarantine-01',
        'chapterId': 'chap-99',
        'pageIndex': 42,
        'readingMode': 'PAGED',
        'scrollPosition': 123.45,
      };

      await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'mut-quarantine-target',
          clientId: kTestClientId,
          domain: SyncDomain.progress,
          entityId: 'story-quarantine-01',
          operation: SyncOperation.upsert,
          baseServerRevision: '50',
          payload: originalPayload,
        ),
        admission: admissionA,
      );

      // Chuyển sang quarantine
      final quarantined = await dal.quarantinePendingMutationByKey(
        ownerScope: scopeA,
        mutationId: 'mut-quarantine-target',
        reason: 'REJECTED_TOMBSTONE: Chapter has been deleted on server',
        status: 'REJECTED_TOMBSTONE',
        admission: admissionA,
      );

      expect(quarantined, isNotNull);
      expect(quarantined!.mutationId, 'mut-quarantine-target');
      expect(quarantined.payload, originalPayload);
      expect(quarantined.rejectionStatus, 'REJECTED_TOMBSTONE');

      // Đọc lại trực tiếp từ SQLite
      final fetchedList = await dal.getQuarantinedMutations(scopeA);
      expect(fetchedList.length, 1);
      expect(fetchedList.first.payload['chapterId'], 'chap-99');
      expect(fetchedList.first.payload['pageIndex'], 42);

      // Pending queue trống
      expect(await dal.getPendingMutations(scopeA), isEmpty);
    });

    test('4. OCC Checkpoint rollback preserves state upon revision conflict', () async {
      await dal.putSyncMeta(
        SyncMeta(
          ownerScope: scopeA,
          lastSyncedServerRevision: '100',
          minActiveRevision: '50',
          lastSyncTimestamp: DateTime.now().toUtc().toIso8601String(),
        ),
        admission: admissionA,
      );

      // Tạo delta page với checkpoint expected khác với DB (DB=100, truyền expectedCheckpoint=90)
      const conflictPage = SyncChangesPage(
        currentServerRevision: '105',
        minActiveRevision: '50',
        hasMore: false,
        nextRevision: null,
        changes: [
          SyncChangeItem(
            revision: '105',
            domain: 'BOOKMARK',
            entityId: 'story-occ-01',
            operation: 'UPSERT',
            payload: {'storyId': 'story-occ-01'},
          ),
        ],
      );

      expect(
        () => dal.applyAuthoritativeDeltaPage(
          ownerScope: scopeA,
          page: conflictPage,
          expectedCheckpoint: '90', // Xung đột với '100'
          admission: admissionA,
        ),
        throwsA(isA<CheckpointConflictError>()),
      );

      // Verify rollback: Checkpoint vẫn là 100, shadow replica không được thêm
      final meta = await dal.getSyncMeta(scopeA);
      expect(meta?.lastSyncedServerRevision, '100');
      final shadow = await dal.getAuthoritativeShadow(
        scopeA,
        SyncDomain.bookmark,
        'story-occ-01',
      );
      expect(shadow, isNull);
    });

    test('5. Cross-account physical isolation between Account A and Account B', () async {
      // Account A
      await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'mut-acc-A',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-A',
          operation: SyncOperation.upsert,
          baseServerRevision: '10',
          payload: const {'storyId': 'story-A'},
        ),
        admission: admissionA,
      );

      // Account B
      await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeB,
          mutationId: 'mut-acc-B',
          clientId: kTestClientIdAlt,
          domain: SyncDomain.bookmark,
          entityId: 'story-B',
          operation: SyncOperation.upsert,
          baseServerRevision: '10',
          payload: const {'storyId': 'story-B'},
        ),
        admission: admissionB,
      );

      final listA = await dal.getPendingMutations(scopeA);
      final listB = await dal.getPendingMutations(scopeB);

      expect(listA.length, 1);
      expect(listA.first.mutationId, 'mut-acc-A');

      expect(listB.length, 1);
      expect(listB.first.mutationId, 'mut-acc-B');

      // Purge A không làm mất dữ liệu của B (bật discardUnsyncedMutations để xoá sạch A)
      await dal.purgeAccountScope(
        ownerScope: scopeA,
        reason: AccountPurgeReason.signOutReset,
        admission: admissionA,
        discardUnsyncedMutations: true,
      );

      expect(await dal.getPendingMutations(scopeA), isEmpty);
      expect((await dal.getPendingMutations(scopeB)).length, 1);
    });

    test('6. Purged guest profile cannot be resurrected (guest_purged_tombstones SSoT)', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final guestProvider = GuestProfileIdentityProvider(
        prefs: prefs,
        offlineDatabase: offlineDb,
      );

      const guestId = 'guest-purged-tombstone-test';
      final guestAdmission = testGuestAdmission('guest:$guestId');

      // Thực hiện xóa vĩnh viễn guest profile
      await dal.purgeGuestLocalScope(
        guestScope: 'guest:$guestId',
        reason: GuestLifecyclePurgeReason.userClearedGuestData,
        admission: guestAdmission,
        guestProfileProvider: guestProvider,
      );

      // Kiểm tra trong SQLite tombstone tồn tại
      final db = offlineDb.database;
      final tombstoneRows = await db.query(
        'guest_purged_tombstones',
        where: 'guest_profile_id = ?',
        whereArgs: [guestId],
      );
      expect(tombstoneRows.length, 1);
      expect(await guestProvider.isGuestScopePurged(guestId), isTrue);

      // Thao tác cách ly hoặc claim lại trên guest đã purge bị từ chối với GuestLifecycleStateError
      expect(
        () => guestProvider.quarantineGuestScope(
          guestId,
          reason: 'Attempted resurrection after purge',
        ),
        throwsA(isA<GuestLifecycleStateError>()),
      );
    });

    test('7. Crash / reopen preserves pending queue and sync checkpoint', () async {
      await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'mut-crash-test',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-crash-01',
          operation: SyncOperation.upsert,
          baseServerRevision: '500',
          payload: const {'storyId': 'story-crash-01'},
        ),
        admission: admissionA,
      );

      await dal.putSyncMeta(
        SyncMeta(
          ownerScope: scopeA,
          lastSyncedServerRevision: '550',
          minActiveRevision: '200',
          lastSyncTimestamp: '2026-11-10T00:00:00.000Z',
        ),
        admission: admissionA,
      );

      // Đóng kết nối để mô phỏng App Crash
      await offlineDb.database.close();

      // Mở lại kết nối từ tệp SQLite
      final reopenedDb = OfflineDatabase();
      await reopenedDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );
      final reopenedDal = SyncStorageDal(offlineDatabase: reopenedDb);

      final pendingList = await reopenedDal.getPendingMutations(scopeA);
      expect(pendingList.length, 1);
      expect(pendingList.first.mutationId, 'mut-crash-test');

      final meta = await reopenedDal.getSyncMeta(scopeA);
      expect(meta?.lastSyncedServerRevision, '550');
      expect(meta?.minActiveRevision, '200');

      await reopenedDb.database.close();
    });

    test('8. BigInt revision 9007199254740995 (> Number.MAX_SAFE_INTEGER) retains exact string in SQLite TEXT', () async {
      const hugeRev = '9007199254740995';

      await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'mut-bigint-01',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-bigint-01',
          operation: SyncOperation.upsert,
          baseServerRevision: hugeRev,
          payload: const {'storyId': 'story-bigint-01'},
        ),
        admission: admissionA,
      );

      await dal.putSyncMeta(
        SyncMeta(
          ownerScope: scopeA,
          lastSyncedServerRevision: hugeRev,
          minActiveRevision: '9007199254740000',
          lastSyncTimestamp: DateTime.now().toUtc().toIso8601String(),
        ),
        admission: admissionA,
      );

      final pending = await dal.getPendingMutations(scopeA);
      expect(pending.first.baseServerRevision, hugeRev);

      final meta = await dal.getSyncMeta(scopeA);
      expect(meta?.lastSyncedServerRevision, hugeRev);

      // Truy vấn raw SQL để chắc chắn lưu TEXT nguyên bản không bị đổi thành double
      final db = offlineDb.database;
      final rawMeta = await db.rawQuery(
        'SELECT typeof(last_synced_server_revision) as rev_type, last_synced_server_revision FROM sync_meta WHERE owner_scope = ?',
        [scopeA],
      );
      expect(rawMeta.first['rev_type'], 'text');
      expect(rawMeta.first['last_synced_server_revision'], hugeRev);
    });
  });

  group('Phase 7C.4 Stage 2A — Task D: Snapshot Materialization Preparation (6 Sync Domains)', () {
    const scopeA = 'account:user-stage2a-snapshot';
    final admission = testAccountAdmission(scopeA);
    const sessionId = 'session-stage2a-001';

    test('1. Snapshot staging partitions 6 domains according to ADR-SYNC-07C-v2.2 contracts', () async {
      final now = DateTime.now().toUtc();
      final items = [
        // 1. BOOKMARK
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 0,
          domain: SyncDomain.bookmark,
          entityKey: 'story-snap-01',
          payload: const {'storyId': 'story-snap-01', 'title': 'Snap Story'},
          stagedAtIso: now.toIso8601String(),
          stagedAtMs: now.millisecondsSinceEpoch,
        ),
        // 2. PROGRESS
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 0,
          domain: SyncDomain.progress,
          entityKey: 'story-snap-01',
          payload: const {
            'storyId': 'story-snap-01',
            'chapterId': 'chap-01',
            'pageIndex': 12,
            'readingMode': 'WEBTOON',
          },
          stagedAtIso: now.toIso8601String(),
          stagedAtMs: now.millisecondsSinceEpoch,
        ),
        // 3. HISTORY (Chapter Read State)
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 1,
          domain: SyncDomain.history,
          entityKey: 'story-snap-01:chap-01',
          payload: const {
            'storyId': 'story-snap-01',
            'chapterId': 'chap-01',
            'progressPercentage': 100,
            'observedHistoryEpoch': 1,
          },
          stagedAtIso: now.toIso8601String(),
          stagedAtMs: now.millisecondsSinceEpoch,
        ),
        // 4. PREFERENCE
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 1,
          domain: SyncDomain.preference,
          entityKey: 'font_size',
          payload: const {'key': 'font_size', 'value': 18},
          stagedAtIso: now.toIso8601String(),
          stagedAtMs: now.millisecondsSinceEpoch,
        ),
      ];

      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: items,
        admission: admission,
      );

      final staged = await dal.getSnapshotStagingItems(scopeA, sessionId);
      expect(staged.length, 4);
      expect(staged.map((s) => s.domain).toSet(), {
        SyncDomain.bookmark,
        SyncDomain.progress,
        SyncDomain.history,
        SyncDomain.preference,
      });
    });

    test('2. Snapshot page ordering is strictly maintained by page_index ASC', () async {
      final now = DateTime.now().toUtc();
      // Chèn trang 2 trước trang 1
      final page2 = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'order-session',
          snapshotRevision: '2000',
          minActiveRevision: '1000',
          pageIndex: 2,
          domain: SyncDomain.bookmark,
          entityKey: 'story-page-2',
          payload: const {'storyId': 'story-page-2'},
          stagedAtIso: now.toIso8601String(),
          stagedAtMs: now.millisecondsSinceEpoch,
        ),
      ];
      final page1 = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'order-session',
          snapshotRevision: '2000',
          minActiveRevision: '1000',
          pageIndex: 1,
          domain: SyncDomain.bookmark,
          entityKey: 'story-page-1',
          payload: const {'storyId': 'story-page-1'},
          stagedAtIso: now.toIso8601String(),
          stagedAtMs: now.millisecondsSinceEpoch,
        ),
      ];

      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: page2,
        admission: admission,
      );

      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: page1,
        admission: admission,
      );

      final staged = await dal.getSnapshotStagingItems(scopeA, 'order-session');
      expect(staged.length, 2);
      expect(staged[0].pageIndex, 1);
      expect(staged[0].entityKey, 'story-page-1');
      expect(staged[1].pageIndex, 2);
      expect(staged[1].entityKey, 'story-page-2');
    });

    test('3. Enforces uniform snapshotRevision per session and rejects mismatched revision pages', () async {
      final now = DateTime.now().toUtc();
      final page1 = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'rev-check-session',
          snapshotRevision: '3000',
          minActiveRevision: '1500',
          pageIndex: 1,
          domain: SyncDomain.bookmark,
          entityKey: 'story-1',
          payload: const {},
          stagedAtIso: now.toIso8601String(),
          stagedAtMs: now.millisecondsSinceEpoch,
        ),
      ];

      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: page1,
        admission: admission,
      );

      // Thử chèn page 2 cùng session nhưng mang revision 3001
      final conflictingPage = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'rev-check-session',
          snapshotRevision: '3001', // Mismatched!
          minActiveRevision: '1500',
          pageIndex: 2,
          domain: SyncDomain.bookmark,
          entityKey: 'story-2',
          payload: const {},
          stagedAtIso: now.toIso8601String(),
          stagedAtMs: now.millisecondsSinceEpoch,
        ),
      ];

      expect(
        () => dal.stageSnapshotItems(
          ownerScope: scopeA,
          items: conflictingPage,
          admission: admission,
        ),
        throwsA(isA<SnapshotStagingConflictError>()),
      );
    });

    test('4. Duplicate page staging handles duplicate items idempotently without error', () async {
      final now = DateTime.now().toUtc();
      final item = SnapshotStagingItem(
        ownerScope: scopeA,
        sessionId: 'dedup-session',
        snapshotRevision: '4000',
        minActiveRevision: '2000',
        pageIndex: 1,
        domain: SyncDomain.bookmark,
        entityKey: 'story-dedup-01',
        payload: const {'storyId': 'story-dedup-01', 'v': 1},
        stagedAtIso: now.toIso8601String(),
        stagedAtMs: now.millisecondsSinceEpoch,
      );

      // Chèn lần 1
      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: [item],
        admission: admission,
      );

      // Chèn lại chính item đó (hoặc cùng PK)
      final duplicateItem = SnapshotStagingItem(
        ownerScope: scopeA,
        sessionId: 'dedup-session',
        snapshotRevision: '4000',
        minActiveRevision: '2000',
        pageIndex: 1,
        domain: SyncDomain.bookmark,
        entityKey: 'story-dedup-01',
        payload: const {'storyId': 'story-dedup-01', 'v': 2},
        stagedAtIso: now.toIso8601String(),
        stagedAtMs: now.millisecondsSinceEpoch,
      );

      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: [duplicateItem],
        admission: admission,
      );

      final items = await dal.getSnapshotStagingItems(scopeA, 'dedup-session');
      expect(items.length, 1);
      expect(items.first.payload['v'], 2); // Idempotent replace
    });

    test('5. Interrupted snapshot recovery clears staging without removing offline pending data', () async {
      // 1. Tạo 1 pending mutation offline
      await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'mut-offline-survivor',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-survivor',
          operation: SyncOperation.upsert,
          baseServerRevision: '100',
          payload: const {'storyId': 'story-survivor'},
        ),
        admission: admission,
      );

      // 2. Chèn 1 trang snapshot dở dang
      final now = DateTime.now().toUtc();
      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: [
          SnapshotStagingItem(
            ownerScope: scopeA,
            sessionId: 'interrupted-session',
            snapshotRevision: '5000',
            minActiveRevision: '2500',
            pageIndex: 1,
            domain: SyncDomain.bookmark,
            entityKey: 'story-snap-interrupted',
            payload: const {},
            stagedAtIso: now.toIso8601String(),
            stagedAtMs: now.millisecondsSinceEpoch,
          ),
        ],
        admission: admission,
      );

      expect((await dal.getSnapshotStagingItems(scopeA, 'interrupted-session')).length, 1);

      // 3. Phục hồi sau gián đoạn: Xóa toàn bộ snapshot staging của session
      await dal.clearSnapshotStaging(
        scopeA,
        sessionId: 'interrupted-session',
        admission: admission,
      );

      expect(await dal.getSnapshotStagingItems(scopeA, 'interrupted-session'), isEmpty);

      // 4. Pending mutation offline vẫn được bảo vệ 100%
      final pendingList = await dal.getPendingMutations(scopeA);
      expect(pendingList.length, 1);
      expect(pendingList.first.mutationId, 'mut-offline-survivor');
    });

    test('6. Staging snapshot NEVER overwrites offline pending mutations', () async {
      // Giả sử người dùng sửa bookmark offline
      await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(
          ownerScope: scopeA,
          storyId: 'story-coexistence-01',
          title: 'Offline User Edited Title',
          createdAt: DateTime.now().toUtc(),
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: scopeA,
          mutationId: 'mut-coexistence-01',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-coexistence-01',
          operation: SyncOperation.upsert,
          baseServerRevision: '100',
          payload: const {'storyId': 'story-coexistence-01', 'title': 'Offline User Edited Title'},
        ),
        admission: admission,
      );

      // Snapshot mang bản ghi cũ hơn từ server cho cùng storyId
      final now = DateTime.now().toUtc();
      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: [
          SnapshotStagingItem(
            ownerScope: scopeA,
            sessionId: 'coexistence-session',
            snapshotRevision: '6000',
            minActiveRevision: '3000',
            pageIndex: 1,
            domain: SyncDomain.bookmark,
            entityKey: 'story-coexistence-01',
            payload: const {'storyId': 'story-coexistence-01', 'title': 'Server Old Title'},
            stagedAtIso: now.toIso8601String(),
            stagedAtMs: now.millisecondsSinceEpoch,
          ),
        ],
        admission: admission,
      );

      // Kiểm tra: Bảng pending_mutations vẫn giữ payload offline của user
      final pending = await dal.getPendingMutations(scopeA);
      expect(pending.length, 1);
      expect(pending.first.payload['title'], 'Offline User Edited Title');

      // Staging table giữ bản ghi snapshot độc lập ở Tầng Staging riêng biệt
      final staged = await dal.getSnapshotStagingItems(scopeA, 'coexistence-session');
      expect(staged.length, 1);
      expect(staged.first.payload['title'], 'Server Old Title');
    });
  });
}
