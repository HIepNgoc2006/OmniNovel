import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/sync/authority/sync_write_admission.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/reconciler/mock_sync_transport.dart';
import 'package:omninovel_mobile/core/sync/reconciler/offline_sync_reconciler.dart';
import 'package:omninovel_mobile/core/sync/reconciler/sync_receipt_validator.dart';
import 'package:omninovel_mobile/core/sync/storage/sync_storage_dal.dart';
import 'package:omninovel_mobile/core/sync/utils/canonical_entity_key.dart';
import 'package:path/path.dart' as p;
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
    tempDir = await Directory.systemTemp.createTemp('snapshot_bootstrap_');
    dbPath = p.join(tempDir.path, 'snapshot_bootstrap.db');
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

  const scopeA = 'account:user-snapshot-alpha';
  const scopeB = 'account:user-snapshot-beta';
  const guestScope = 'guest:profile-snap-guest';

  PendingMutationRecord createSampleMutation({
    required String ownerScope,
    required String mutationId,
    required String storyId,
    String baseServerRevision = '100',
    SyncDomain domain = SyncDomain.bookmark,
    SyncOperation operation = SyncOperation.upsert,
    Map<String, Object?>? payload,
  }) {
    return PendingMutationRecord.create(
      ownerScope: ownerScope,
      mutationId: mutationId,
      clientId: kTestClientId,
      domain: domain,
      entityId: storyId,
      operation: operation,
      baseServerRevision: baseServerRevision,
      payload: payload ?? {'storyId': storyId, 'title': 'Pending Title $storyId'},
    );
  }

  // =========================================================================
  // TASK A: Cross-Client Receipt Conformance & Stale Revision
  // =========================================================================
  group('Task A — Cross-Client Receipt Conformance Tests', () {
    test('1. Receipt replay / duplicate receipt in batch response rejected fail-closed (DUPLICATE_RECEIPT)', () async {
      final admission = testAccountAdmission(scopeA);
      final m1 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-replay-01', storyId: 'story-01');
      await dal.enqueuePendingMutation(m1, admission: admission);

      final sent = [ClientMutationWire.fromPendingRecord(m1)];
      final duplicateResponse = PushMutationsBatchResponseWire(
        processedCount: 1,
        newServerRevision: '110',
        results: const [
          MutationResultItemWire(mutationId: 'mut-replay-01', status: 'APPLIED', assignedRevision: '105'),
          MutationResultItemWire(mutationId: 'mut-replay-01', status: 'APPLIED', assignedRevision: '106'),
        ],
      );

      expect(
        () => SyncReceiptValidator.validate(sentMutations: sent, response: duplicateResponse),
        throwsA(isA<ReceiptValidationException>().having(
          (e) => e.message,
          'message',
          contains('RECEIPT_COUNT_MISMATCH'),
        )),
      );
    });

    test('2. Duplicate mutationId in results list matching count throws DUPLICATE_RECEIPT', () {
      final m1 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-dup-01', storyId: 'story-01');
      final m2 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-dup-02', storyId: 'story-02');
      final sent = [
        ClientMutationWire.fromPendingRecord(m1),
        ClientMutationWire.fromPendingRecord(m2),
      ];

      final duplicateResponse = PushMutationsBatchResponseWire(
        processedCount: 2,
        newServerRevision: '120',
        results: const [
          MutationResultItemWire(mutationId: 'mut-dup-01', status: 'APPLIED', assignedRevision: '110'),
          MutationResultItemWire(mutationId: 'mut-dup-01', status: 'APPLIED', assignedRevision: '111'),
        ],
      );

      expect(
        () => SyncReceiptValidator.validate(sentMutations: sent, response: duplicateResponse),
        throwsA(isA<ReceiptValidationException>().having(
          (e) => e.message,
          'message',
          contains('DUPLICATE_RECEIPT'),
        )),
      );
    });

    test('3. Missing receipt (count mismatch or absent mutationId) throws ReceiptValidationException', () {
      final m1 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-miss-01', storyId: 'story-01');
      final m2 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-miss-02', storyId: 'story-02');
      final sent = [
        ClientMutationWire.fromPendingRecord(m1),
        ClientMutationWire.fromPendingRecord(m2),
      ];

      // Missing mut-miss-02
      final partialResponse = PushMutationsBatchResponseWire(
        processedCount: 2,
        newServerRevision: '120',
        results: const [
          MutationResultItemWire(mutationId: 'mut-miss-01', status: 'APPLIED', assignedRevision: '110'),
        ],
      );

      expect(
        () => SyncReceiptValidator.validate(sentMutations: sent, response: partialResponse),
        throwsA(isA<ReceiptValidationException>().having(
          (e) => e.message,
          'message',
          contains('RECEIPT_COUNT_MISMATCH'),
        )),
      );
    });

    test('4. Unexpected mutationId not in sent batch throws ReceiptValidationException', () {
      final m1 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-unexp-01', storyId: 'story-01');
      final sent = [ClientMutationWire.fromPendingRecord(m1)];

      final unexpectedResponse = PushMutationsBatchResponseWire(
        processedCount: 1,
        newServerRevision: '120',
        results: const [
          MutationResultItemWire(mutationId: 'mut-intruder-99', status: 'APPLIED', assignedRevision: '110'),
        ],
      );

      expect(
        () => SyncReceiptValidator.validate(sentMutations: sent, response: unexpectedResponse),
        throwsA(isA<ReceiptValidationException>().having(
          (e) => e.message,
          'message',
          contains('UNEXPECTED_MUTATION_ID'),
        )),
      );
    });

    test('5. Unrecognized receipt status (UNKNOWN_STATUS) throws ReceiptValidationException and does NOT quarantine', () async {
      final admission = testAccountAdmission(scopeA);
      final m1 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-unrec-01', storyId: 'story-01');
      await dal.enqueuePendingMutation(m1, admission: admission);
      final sent = [ClientMutationWire.fromPendingRecord(m1)];

      final unrecResponse = PushMutationsBatchResponseWire(
        processedCount: 1,
        newServerRevision: '120',
        results: const [
          MutationResultItemWire(mutationId: 'mut-unrec-01', status: 'MYSTERY_STATUS', assignedRevision: '110'),
        ],
      );

      expect(
        () => dal.settleBatchReceiptsAtomic(
          ownerScope: scopeA,
          sentMutations: sent,
          response: unrecResponse,
          admission: admission,
        ),
        throwsA(isA<ReceiptValidationException>().having(
          (e) => e.message,
          'message',
          contains('UNRECOGNIZED_RECEIPT_STATUS'),
        )),
      );

      // Pending mutation preserved, 0 quarantined
      expect(await dal.getPendingMutations(scopeA), hasLength(1));
      expect(await dal.getQuarantinedMutations(scopeA), isEmpty);
    });

    test('6. Stale assignedRevision on APPLIED (< baseServerRevision) throws STALE_ASSIGNED_REVISION', () {
      final m1 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-stale-01',
        storyId: 'story-01',
        baseServerRevision: '100',
      );
      final sent = [ClientMutationWire.fromPendingRecord(m1)];

      // Server returns APPLIED with assignedRevision '90' < baseServerRevision '100'
      final staleResponse = PushMutationsBatchResponseWire(
        processedCount: 1,
        newServerRevision: '120',
        results: const [
          MutationResultItemWire(mutationId: 'mut-stale-01', status: 'APPLIED', assignedRevision: '90'),
        ],
      );

      expect(
        () => SyncReceiptValidator.validate(sentMutations: sent, response: staleResponse),
        throwsA(isA<ReceiptValidationException>().having(
          (e) => e.message,
          'message',
          contains('STALE_ASSIGNED_REVISION'),
        )),
      );
    });

    test('7. Stale newServerRevision (< baseServerRevision) throws STALE_SERVER_REVISION', () {
      final m1 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-stale-srv',
        storyId: 'story-01',
        baseServerRevision: '150',
      );
      final sent = [ClientMutationWire.fromPendingRecord(m1)];

      // newServerRevision '140' < baseServerRevision '150'
      final staleResponse = PushMutationsBatchResponseWire(
        processedCount: 1,
        newServerRevision: '140',
        results: const [
          MutationResultItemWire(mutationId: 'mut-stale-srv', status: 'APPLIED', assignedRevision: '155'),
        ],
      );

      expect(
        () => SyncReceiptValidator.validate(sentMutations: sent, response: staleResponse),
        throwsA(isA<ReceiptValidationException>().having(
          (e) => e.message,
          'message',
          contains('STALE_SERVER_REVISION'),
        )),
      );
    });

    test('8. Batch reject policy verification: fail-closed preserves pending queue 100%', () async {
      final admission = testAccountAdmission(scopeA);
      final m1 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-all-or-nothing-1', storyId: 's1');
      final m2 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-all-or-nothing-2', storyId: 's2');
      await dal.enqueuePendingMutation(m1, admission: admission);
      await dal.enqueuePendingMutation(m2, admission: admission);

      final sent = [
        ClientMutationWire.fromPendingRecord(m1),
        ClientMutationWire.fromPendingRecord(m2),
      ];

      // Second receipt is invalid (missing assignedRevision on APPLIED)
      final malformedBatch = PushMutationsBatchResponseWire(
        processedCount: 2,
        newServerRevision: '200',
        results: const [
          MutationResultItemWire(mutationId: 'mut-all-or-nothing-1', status: 'APPLIED', assignedRevision: '150'),
          MutationResultItemWire(mutationId: 'mut-all-or-nothing-2', status: 'APPLIED', assignedRevision: null),
        ],
      );

      expect(
        () => dal.settleBatchReceiptsAtomic(
          ownerScope: scopeA,
          sentMutations: sent,
          response: malformedBatch,
          admission: admission,
        ),
        throwsA(isA<ReceiptValidationException>()),
      );

      // Both mutations remain in pending queue
      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter, hasLength(2));
      expect(pendingAfter.map((m) => m.mutationId).toSet(), {'mut-all-or-nothing-1', 'mut-all-or-nothing-2'});
    });
  });

  // =========================================================================
  // TASK B: Snapshot Bootstrap Safety (6 Domains & Multi-Page Staging)
  // =========================================================================
  group('Task B — Snapshot Bootstrap Safety Tests', () {
    const sessionId = 'session-boot-001';
    final now = DateTime.now().toUtc();
    final nowIso = now.toIso8601String();
    final nowMs = now.millisecondsSinceEpoch;

    test('9. Snapshot 6 domains staging & materialization into replicas & local preferences', () async {
      final admission = testAccountAdmission(scopeA);

      final items = [
        // 1. BOOKMARK
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 0,
          domain: SyncDomain.bookmark,
          entityKey: 'story-alpha',
          payload: const {'storyId': 'story-alpha', 'title': 'Alpha Manga'},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
        // 2. PROGRESS
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 0,
          domain: SyncDomain.progress,
          entityKey: 'story-alpha',
          payload: const {
            'storyId': 'story-alpha',
            'chapterId': 'chap-10',
            'pageIndex': 15,
            'readingMode': 'WEBTOON',
            'observedHistoryEpoch': 2,
          },
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
        // 3. CHAPTER_READ_STATE (HISTORY)
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 1,
          domain: SyncDomain.history,
          entityKey: 'story-alpha:chap-10',
          payload: const {
            'storyId': 'story-alpha',
            'chapterId': 'chap-10',
            'progressPercentage': 100,
            'storyHistoryEpoch': 2,
          },
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
        // 4. PREFERENCE
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 1,
          domain: SyncDomain.preference,
          entityKey: 'reader_dark_mode',
          payload: const {'key': 'reader_dark_mode', 'value': true},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
        // 5. HISTORY_EPOCH (Story level & global)
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 2,
          domain: SyncDomain.history,
          entityKey: kGlobalHistorySentinelUuid,
          payload: const {
            'storyId': kGlobalHistorySentinelUuid,
            'epoch': 5,
          },
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
        // 6. TOMBSTONE
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: sessionId,
          snapshotRevision: '1000',
          minActiveRevision: '500',
          pageIndex: 2,
          domain: SyncDomain.bookmark,
          entityKey: 'story-tombstoned',
          payload: const {
            'storyId': 'story-tombstoned',
            'isDeleted': true,
            'deletedAtRevision': '600',
          },
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      await dal.stageSnapshotItems(
        ownerScope: scopeA,
        items: items,
        admission: admission,
      );

      final commitResult = await dal.commitAuthoritativeSnapshot(
        ownerScope: scopeA,
        sessionId: sessionId,
        admission: admission,
      );

      expect(commitResult.snapshotRevision, '1000');
      expect(commitResult.minActiveRevision, '500');
      expect(commitResult.materializedCount, 6);
      expect(commitResult.effectiveEpochs[kGlobalHistorySentinelUuid], 5);
      expect(commitResult.effectiveEpochs['story-alpha'], 2);

      // Verify replicas in SQLite
      final db = offlineDb.database;
      final replicas = await db.query(
        'sync_authoritative_replicas',
        where: 'owner_scope = ?',
        whereArgs: [scopeA],
      );
      expect(replicas, hasLength(6));

      // Verify tombstone is marked with is_deleted = 1
      final tombstoneRow = replicas.firstWhere((r) => r['entity_key'] == 'story-tombstoned');
      expect(tombstoneRow['is_deleted'], 1);

      // Verify local preferences updated
      final pref = await dal.getAccountLocalPreference(scopeA, 'reader_dark_mode');
      expect(pref?.value, isTrue);

      // Verify staging table emptied
      final remainingStaging = await dal.getSnapshotStagingItems(scopeA, sessionId);
      expect(remainingStaging, isEmpty);
    });

    test('10. Multi-page staging with cursors commits all items atomically', () async {
      final admission = testAccountAdmission(scopeA);
      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
      );

      final page1 = SyncSnapshotResponseWire(
        snapshotRevision: '2000',
        minActiveRevision: '1000',
        hasMore: true,
        nextCursor: 'cursor-p2',
        items: [
          SnapshotStagingItem(
            ownerScope: scopeA,
            sessionId: 'multipage-session',
            snapshotRevision: '2000',
            minActiveRevision: '1000',
            pageIndex: 0,
            cursorToken: 'cursor-p2',
            domain: SyncDomain.bookmark,
            entityKey: 'bm-p1',
            payload: const {'storyId': 'bm-p1'},
            stagedAtIso: nowIso,
            stagedAtMs: nowMs,
          ),
        ],
      );

      final page2 = SyncSnapshotResponseWire(
        snapshotRevision: '2000',
        minActiveRevision: '1000',
        hasMore: true,
        nextCursor: 'cursor-p3',
        items: [
          SnapshotStagingItem(
            ownerScope: scopeA,
            sessionId: 'multipage-session',
            snapshotRevision: '2000',
            minActiveRevision: '1000',
            pageIndex: 1,
            cursorToken: 'cursor-p3',
            domain: SyncDomain.bookmark,
            entityKey: 'bm-p2',
            payload: const {'storyId': 'bm-p2'},
            stagedAtIso: nowIso,
            stagedAtMs: nowMs,
          ),
        ],
      );

      final page3 = SyncSnapshotResponseWire(
        snapshotRevision: '2000',
        minActiveRevision: '1000',
        hasMore: false,
        nextCursor: null,
        items: [
          SnapshotStagingItem(
            ownerScope: scopeA,
            sessionId: 'multipage-session',
            snapshotRevision: '2000',
            minActiveRevision: '1000',
            pageIndex: 2,
            cursorToken: null,
            domain: SyncDomain.bookmark,
            entityKey: 'bm-p3',
            payload: const {'storyId': 'bm-p3'},
            stagedAtIso: nowIso,
            stagedAtMs: nowMs,
          ),
        ],
      );

      final result = await reconciler.bootstrapFromSnapshot(
        ownerScope: scopeA,
        sessionId: 'multipage-session',
        pages: [page1, page2, page3],
        admission: admission,
      );

      expect(result.materializedCount, 3);
      expect(result.snapshotRevision, '2000');

      final db = offlineDb.database;
      final replicas = await db.query(
        'sync_authoritative_replicas',
        where: 'owner_scope = ?',
        whereArgs: [scopeA],
      );
      expect(replicas, hasLength(3));
      expect(replicas.map((r) => r['entity_key']).toSet(), {'bm-p1', 'bm-p2', 'bm-p3'});
    });

    test('11. Reordered pages staging (Page 2, then Page 0, then Page 1) materializes in deterministic order', () async {
      final admission = testAccountAdmission(scopeA);

      final page2 = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'reorder-session',
          snapshotRevision: '3000',
          minActiveRevision: '1500',
          pageIndex: 2,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-reorder-2',
          payload: const {'storyId': 'bm-reorder-2'},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      final page0 = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'reorder-session',
          snapshotRevision: '3000',
          minActiveRevision: '1500',
          pageIndex: 0,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-reorder-0',
          payload: const {'storyId': 'bm-reorder-0'},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      final page1 = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'reorder-session',
          snapshotRevision: '3000',
          minActiveRevision: '1500',
          pageIndex: 1,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-reorder-1',
          payload: const {'storyId': 'bm-reorder-1'},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      // Stage in random order: 2, 0, 1
      await dal.stageSnapshotItems(ownerScope: scopeA, items: page2, admission: admission);
      await dal.stageSnapshotItems(ownerScope: scopeA, items: page0, admission: admission);
      await dal.stageSnapshotItems(ownerScope: scopeA, items: page1, admission: admission);

      final staged = await dal.getSnapshotStagingItems(scopeA, 'reorder-session');
      expect(staged.map((s) => s.pageIndex).toList(), [0, 1, 2]);

      final commitResult = await dal.commitAuthoritativeSnapshot(
        ownerScope: scopeA,
        sessionId: 'reorder-session',
        admission: admission,
      );
      expect(commitResult.materializedCount, 3);
    });

    test('12. Duplicate pages/items handled idempotently without error', () async {
      final admission = testAccountAdmission(scopeA);

      final item = SnapshotStagingItem(
        ownerScope: scopeA,
        sessionId: 'idempotent-session',
        snapshotRevision: '4000',
        minActiveRevision: '2000',
        pageIndex: 0,
        domain: SyncDomain.bookmark,
        entityKey: 'bm-dup-item',
        payload: const {'storyId': 'bm-dup-item', 'version': 1},
        stagedAtIso: nowIso,
        stagedAtMs: nowMs,
      );

      // Stage duplicate items
      await dal.stageSnapshotItems(ownerScope: scopeA, items: [item], admission: admission);
      await dal.stageSnapshotItems(ownerScope: scopeA, items: [item], admission: admission);

      final staged = await dal.getSnapshotStagingItems(scopeA, 'idempotent-session');
      expect(staged, hasLength(1));

      final commitResult = await dal.commitAuthoritativeSnapshot(
        ownerScope: scopeA,
        sessionId: 'idempotent-session',
        admission: admission,
      );
      expect(commitResult.materializedCount, 1);
    });

    test('13. Missing / empty staging session throws SnapshotStagingConflictError fail-closed', () async {
      final admission = testAccountAdmission(scopeA);

      expect(
        () => dal.commitAuthoritativeSnapshot(
          ownerScope: scopeA,
          sessionId: 'non-existent-session',
          admission: admission,
        ),
        throwsA(isA<SnapshotStagingConflictError>().having(
          (e) => e.message,
          'message',
          contains('NO_STAGED_SNAPSHOT'),
        )),
      );
    });
  });

  // =========================================================================
  // TASK B (cont): Revision Invariants & Checkpoint Consistency
  // =========================================================================
  group('Task B — Revision Invariants & Checkpoint Consistency', () {
    final now = DateTime.now().toUtc();
    final nowIso = now.toIso8601String();
    final nowMs = now.millisecondsSinceEpoch;

    test('14. Staging mismatched revisions in same session rejected with SnapshotStagingConflictError', () async {
      final admission = testAccountAdmission(scopeA);

      final page1 = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'rev-mismatch-session',
          snapshotRevision: '5000',
          minActiveRevision: '2500',
          pageIndex: 0,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-1',
          payload: const {},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      final page2Conflicting = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'rev-mismatch-session',
          snapshotRevision: '5001', // Mismatched revision!
          minActiveRevision: '2500',
          pageIndex: 1,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-2',
          payload: const {},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      await dal.stageSnapshotItems(ownerScope: scopeA, items: page1, admission: admission);

      expect(
        () => dal.stageSnapshotItems(ownerScope: scopeA, items: page2Conflicting, admission: admission),
        throwsA(isA<SnapshotStagingConflictError>().having(
          (e) => e.message,
          'message',
          contains('SNAPSHOT_REVISION_MISMATCH'),
        )),
      );
    });

    test('15. minActiveRevision > snapshotRevision rejected fail-closed', () async {
      final admission = testAccountAdmission(scopeA);

      final invalidWindowItem = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'window-session',
          snapshotRevision: '1000',
          minActiveRevision: '2000', // minActive > snapshotRevision!
          pageIndex: 0,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-window',
          payload: const {},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      // Direct insert into SQLite to simulate tampered staging table
      final db = offlineDb.database;
      await db.insert('snapshot_staging_store', invalidWindowItem.first.toMap());

      expect(
        () => dal.commitAuthoritativeSnapshot(
          ownerScope: scopeA,
          sessionId: 'window-session',
          admission: admission,
        ),
        throwsA(isA<SnapshotStagingConflictError>().having(
          (e) => e.message,
          'message',
          contains('REGRESSIVE_SNAPSHOT_WINDOW'),
        )),
      );
    });

    test('16. Checkpoint consistency: lastSyncedServerRevision and minActiveRevision updated exactly', () async {
      final admission = testAccountAdmission(scopeA);

      final item = SnapshotStagingItem(
        ownerScope: scopeA,
        sessionId: 'ckpt-session',
        snapshotRevision: '8888',
        minActiveRevision: '4444',
        pageIndex: 0,
        domain: SyncDomain.bookmark,
        entityKey: 'bm-ckpt',
        payload: const {'storyId': 'bm-ckpt'},
        stagedAtIso: nowIso,
        stagedAtMs: nowMs,
      );

      await dal.stageSnapshotItems(ownerScope: scopeA, items: [item], admission: admission);
      await dal.commitAuthoritativeSnapshot(ownerScope: scopeA, sessionId: 'ckpt-session', admission: admission);

      final meta = await dal.getSyncMeta(scopeA);
      expect(meta, isNotNull);
      expect(meta!.lastSyncedServerRevision, '8888');
      expect(meta.minActiveRevision, '4444');
      expect(meta.syncState, SyncExecutionState.idle);
      expect(meta.authoritativeBaselineStatus, AuthoritativeBaselineStatus.bootstrapping);
    });
  });

  // =========================================================================
  // TASK B & C: Interrupted Bootstrap, Crash Recovery & Reopening
  // =========================================================================
  group('Task B & C — Interrupted Bootstrap, Crash & Reopen Recovery', () {
    final now = DateTime.now().toUtc();
    final nowIso = now.toIso8601String();
    final nowMs = now.millisecondsSinceEpoch;

    test('17. Interrupted bootstrap midway: clearing staging preserves existing authoritative baseline and pending mutations', () async {
      final admission = testAccountAdmission(scopeA);

      // Existing baseline
      await dal.putSyncMeta(
        SyncMeta(
          ownerScope: scopeA,
          lastSyncedServerRevision: '50',
          minActiveRevision: '10',
          lastSyncTimestamp: nowIso,
          effectiveHistoryEpochs: const {},
          syncState: SyncExecutionState.idle,
          authoritativeBaselineStatus: AuthoritativeBaselineStatus.bootstrapping,
        ),
        admission: admission,
      );

      // Existing pending mutation
      final pending = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-interrupted', storyId: 'story-survive');
      await dal.enqueuePendingMutation(pending, admission: admission);

      // Interrupted staging
      final stagingItems = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'interrupted-session',
          snapshotRevision: '9999',
          minActiveRevision: '5000',
          pageIndex: 0,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-uncommitted',
          payload: const {},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];
      await dal.stageSnapshotItems(ownerScope: scopeA, items: stagingItems, admission: admission);

      // Network drop: client cancels and clears staging
      await dal.clearSnapshotStaging(scopeA, sessionId: 'interrupted-session', admission: admission);

      // Staging empty
      expect(await dal.getSnapshotStagingItems(scopeA, 'interrupted-session'), isEmpty);

      // Authoritative baseline and pending mutations 100% intact
      final meta = await dal.getSyncMeta(scopeA);
      expect(meta!.lastSyncedServerRevision, '50');
      final pendingList = await dal.getPendingMutations(scopeA);
      expect(pendingList, hasLength(1));
      expect(pendingList.first.mutationId, 'mut-interrupted');
    });

    test('18. Crash simulation midway before commit via onBeforeCommitHook rolls back 100% (zero partial replicas)', () async {
      final admission = testAccountAdmission(scopeA);

      final items = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'crash-session',
          snapshotRevision: '6000',
          minActiveRevision: '3000',
          pageIndex: 0,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-crash',
          payload: const {'storyId': 'bm-crash'},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      await dal.stageSnapshotItems(ownerScope: scopeA, items: items, admission: admission);

      // Injected crash hook
      expect(
        () => dal.commitAuthoritativeSnapshot(
          ownerScope: scopeA,
          sessionId: 'crash-session',
          admission: admission,
          onBeforeCommitHook: (txn) async {
            throw Exception('INJECTED_SQLITE_CRASH_MIDWAY');
          },
        ),
        throwsA(isA<Exception>().having((e) => e.toString(), 'error', contains('INJECTED_SQLITE_CRASH_MIDWAY'))),
      );

      // Zero replicas written
      final db = offlineDb.database;
      final replicas = await db.query(
        'sync_authoritative_replicas',
        where: 'owner_scope = ?',
        whereArgs: [scopeA],
      );
      expect(replicas, isEmpty);

      // Staging table preserved for retry
      final staged = await dal.getSnapshotStagingItems(scopeA, 'crash-session');
      expect(staged, hasLength(1));
    });

    test('19. Reopening SQLite database after aborted bootstrap confirms database integrity and clean recovery', () async {
      final admission = testAccountAdmission(scopeA);

      final items = [
        SnapshotStagingItem(
          ownerScope: scopeA,
          sessionId: 'reopen-session',
          snapshotRevision: '7000',
          minActiveRevision: '3500',
          pageIndex: 0,
          domain: SyncDomain.bookmark,
          entityKey: 'bm-reopen',
          payload: const {'storyId': 'bm-reopen'},
          stagedAtIso: nowIso,
          stagedAtMs: nowMs,
        ),
      ];

      await dal.stageSnapshotItems(ownerScope: scopeA, items: items, admission: admission);

      // Aborted commit
      try {
        await dal.commitAuthoritativeSnapshot(
          ownerScope: scopeA,
          sessionId: 'reopen-session',
          admission: admission,
          onBeforeCommitHook: (txn) async {
            throw const FormatException('SIMULATED_PROCESS_TERMINATION');
          },
        );
      } catch (_) {}

      // Close and reopen database
      await offlineDb.database.close();
      await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );

      final reopenedDal = SyncStorageDal(offlineDatabase: offlineDb);

      // Staged items preserved, zero partial replicas
      final staged = await reopenedDal.getSnapshotStagingItems(scopeA, 'reopen-session');
      expect(staged, hasLength(1));

      final db = offlineDb.database;
      final replicas = await db.query('sync_authoritative_replicas', where: 'owner_scope = ?', whereArgs: [scopeA]);
      expect(replicas, isEmpty);

      // Retry commit succeeds cleanly
      final result = await reopenedDal.commitAuthoritativeSnapshot(
        ownerScope: scopeA,
        sessionId: 'reopen-session',
        admission: admission,
      );
      expect(result.materializedCount, 1);
      expect(result.snapshotRevision, '7000');
    });
  });

  // =========================================================================
  // TASK B & C: Authority, Data Integrity, Pending Preservation & Scope Isolation
  // =========================================================================
  group('Task B & C — Authority, Pending Preservation & Scope Isolation', () {
    final now = DateTime.now().toUtc();
    final nowIso = now.toIso8601String();
    final nowMs = now.millisecondsSinceEpoch;

    test('20. Offline pending mutations preserved and rebased monotonically to snapshot revision', () async {
      final admission = testAccountAdmission(scopeA);

      // Create 3 offline pending mutations with older base revisions
      final p1 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-rebase-1', storyId: 's1', baseServerRevision: '100');
      final p2 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-rebase-2', storyId: 's2', baseServerRevision: '150');
      final p3 = createSampleMutation(ownerScope: scopeA, mutationId: 'mut-rebase-3', storyId: 's3', baseServerRevision: '800'); // Higher than snapshot!

      await dal.enqueuePendingMutation(p1, admission: admission);
      await dal.enqueuePendingMutation(p2, admission: admission);
      await dal.enqueuePendingMutation(p3, admission: admission);

      // Snapshot at revision 500
      final item = SnapshotStagingItem(
        ownerScope: scopeA,
        sessionId: 'rebase-session',
        snapshotRevision: '500',
        minActiveRevision: '250',
        pageIndex: 0,
        domain: SyncDomain.bookmark,
        entityKey: 's1',
        payload: const {'storyId': 's1'},
        stagedAtIso: nowIso,
        stagedAtMs: nowMs,
      );

      await dal.stageSnapshotItems(ownerScope: scopeA, items: [item], admission: admission);

      final commitResult = await dal.commitAuthoritativeSnapshot(
        ownerScope: scopeA,
        sessionId: 'rebase-session',
        admission: admission,
      );

      // 2 mutations rebased (p1 and p2), p3 was already 800 > 500
      expect(commitResult.rebasedPendingCount, 2);

      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter, hasLength(3));

      // Invariant: FIFO sequence_no, client_id, and payloads 100% preserved
      final rebasedP1 = pendingAfter.firstWhere((m) => m.mutationId == 'mut-rebase-1');
      expect(rebasedP1.baseServerRevision, '500');
      expect(rebasedP1.sequenceNo, 1);

      final rebasedP2 = pendingAfter.firstWhere((m) => m.mutationId == 'mut-rebase-2');
      expect(rebasedP2.baseServerRevision, '500');
      expect(rebasedP2.sequenceNo, 2);

      final rebasedP3 = pendingAfter.firstWhere((m) => m.mutationId == 'mut-rebase-3');
      expect(rebasedP3.baseServerRevision, '800'); // Untouched because 800 > 500
      expect(rebasedP3.sequenceNo, 3);
    });

    test('21. Snapshot items with conflicting keys do NOT overwrite or discard offline pending mutations', () async {
      final admission = testAccountAdmission(scopeA);

      // User modified reading progress offline
      final offlinePending = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-conflict-progress',
        storyId: 'story-clash',
        domain: SyncDomain.progress,
        payload: const {
          'storyId': 'story-clash',
          'chapterId': 'chap-offline',
          'pageIndex': 42,
        },
      );
      await dal.enqueuePendingMutation(offlinePending, admission: admission);

      // Snapshot has server-side reading progress for same story
      final snapshotItem = SnapshotStagingItem(
        ownerScope: scopeA,
        sessionId: 'conflict-session',
        snapshotRevision: '1200',
        minActiveRevision: '600',
        pageIndex: 0,
        domain: SyncDomain.progress,
        entityKey: 'story-clash',
        payload: const {
          'storyId': 'story-clash',
          'chapterId': 'chap-server',
          'pageIndex': 10,
        },
        stagedAtIso: nowIso,
        stagedAtMs: nowMs,
      );

      await dal.stageSnapshotItems(ownerScope: scopeA, items: [snapshotItem], admission: admission);
      await dal.commitAuthoritativeSnapshot(ownerScope: scopeA, sessionId: 'conflict-session', admission: admission);

      // Offline pending mutation is completely intact
      final pendingList = await dal.getPendingMutations(scopeA);
      expect(pendingList, hasLength(1));
      expect(pendingList.first.mutationId, 'mut-conflict-progress');
      expect(pendingList.first.payload['pageIndex'], 42);
      expect(pendingList.first.baseServerRevision, '1200'); // Rebased safely
    });

    test('22. Guest scope rejected immediately from snapshot staging and bootstrap (assertAccountScope)', () async {
      final admission = testAccountAdmission(scopeA);

      final item = SnapshotStagingItem(
        ownerScope: guestScope,
        sessionId: 'guest-session',
        snapshotRevision: '100',
        minActiveRevision: '50',
        pageIndex: 0,
        domain: SyncDomain.bookmark,
        entityKey: 'bm-guest',
        payload: const {},
        stagedAtIso: nowIso,
        stagedAtMs: nowMs,
      );

      // Attempting to stage snapshot with guest scope throws InvalidSyncScopeException
      expect(
        () => dal.stageSnapshotItems(
          ownerScope: guestScope,
          items: [item],
          admission: admission,
        ),
        throwsA(isA<InvalidSyncScopeException>()),
      );

      expect(
        () => dal.commitAuthoritativeSnapshot(
          ownerScope: guestScope,
          sessionId: 'guest-session',
          admission: admission,
        ),
        throwsA(isA<InvalidSyncScopeException>()),
      );
    });

    test('23. Strict account isolation: Account A snapshot bootstrap does NOT bleed into Account B', () async {
      final admissionA = testAccountAdmission(scopeA);
      final admissionB = testAccountAdmission(scopeB);

      // Account B has pre-existing replicas and pending mutations
      final pB = createSampleMutation(ownerScope: scopeB, mutationId: 'mut-b-01', storyId: 'story-b');
      await dal.enqueuePendingMutation(pB, admission: admissionB);

      // Account A commits snapshot
      final itemA = SnapshotStagingItem(
        ownerScope: scopeA,
        sessionId: 'scope-iso-session',
        snapshotRevision: '1500',
        minActiveRevision: '750',
        pageIndex: 0,
        domain: SyncDomain.bookmark,
        entityKey: 'story-a-only',
        payload: const {'storyId': 'story-a-only'},
        stagedAtIso: nowIso,
        stagedAtMs: nowMs,
      );
      await dal.stageSnapshotItems(ownerScope: scopeA, items: [itemA], admission: admissionA);
      await dal.commitAuthoritativeSnapshot(ownerScope: scopeA, sessionId: 'scope-iso-session', admission: admissionA);

      // Account B is 100% untouched
      final pendingB = await dal.getPendingMutations(scopeB);
      expect(pendingB, hasLength(1));
      expect(pendingB.first.mutationId, 'mut-b-01');
      expect(pendingB.first.baseServerRevision, '100'); // NOT rebased by Account A

      final db = offlineDb.database;
      final replicasB = await db.query('sync_authoritative_replicas', where: 'owner_scope = ?', whereArgs: [scopeB]);
      expect(replicasB, isEmpty);

      final replicasA = await db.query('sync_authoritative_replicas', where: 'owner_scope = ?', whereArgs: [scopeA]);
      expect(replicasA, hasLength(1));
      expect(replicasA.first['entity_key'], 'story-a-only');
    });

    test('24. Async boundary admission check: revoking admission during async gap aborts before SQLite mutation', () async {
      final mutableSource = MutableSyncAuthoritySource.activeAccount('user-async-boundary');
      const testScope = 'account:user-async-boundary';
      final admission = AccountWriteAdmission(
        authoritySource: mutableSource,
        expectedUserId: 'user-async-boundary',
        expectedGeneration: 1,
      );

      final item = SnapshotStagingItem(
        ownerScope: testScope,
        sessionId: 'async-boundary-session',
        snapshotRevision: '2500',
        minActiveRevision: '1250',
        pageIndex: 0,
        domain: SyncDomain.bookmark,
        entityKey: 'story-async',
        payload: const {'storyId': 'story-async'},
        stagedAtIso: nowIso,
        stagedAtMs: nowMs,
      );

      await dal.stageSnapshotItems(ownerScope: testScope, items: [item], admission: admission);

      // Revoke admission (logout or switch account)
      mutableSource.isAuthenticated = false;
      mutableSource.authenticatedUserId = null;
      mutableSource.scopeState = ActiveScopeState.guest;

      // commitAuthoritativeSnapshot fails closed immediately at Barrier 1
      expect(
        () => dal.commitAuthoritativeSnapshot(
          ownerScope: testScope,
          sessionId: 'async-boundary-session',
          admission: admission,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // Replicas table remains empty
      final db = offlineDb.database;
      final replicas = await db.query('sync_authoritative_replicas', where: 'owner_scope = ?', whereArgs: [testScope]);
      expect(replicas, isEmpty);
    });

    test('25. Authoritative baseline ready lock: status stays BOOTSTRAPPING, attempting READY elevation throws ReadyStatusTransitionForbiddenError', () async {
      final admission = testAccountAdmission(scopeA);
      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
      );

      final item = SnapshotStagingItem(
        ownerScope: scopeA,
        sessionId: 'ready-lock-session',
        snapshotRevision: '3333',
        minActiveRevision: '1111',
        pageIndex: 0,
        domain: SyncDomain.bookmark,
        entityKey: 'story-lock',
        payload: const {'storyId': 'story-lock'},
        stagedAtIso: nowIso,
        stagedAtMs: nowMs,
      );

      final page = SyncSnapshotResponseWire(
        snapshotRevision: '3333',
        minActiveRevision: '1111',
        hasMore: false,
        nextCursor: null,
        items: [item],
      );

      final result = await reconciler.bootstrapFromSnapshot(
        ownerScope: scopeA,
        sessionId: 'ready-lock-session',
        pages: [page],
        admission: admission,
      );

      expect(result.snapshotRevision, '3333');

      // SyncMeta baseline status must be BOOTSTRAPPING, never READY
      final meta = await dal.getSyncMeta(scopeA);
      expect(meta!.authoritativeBaselineStatus, AuthoritativeBaselineStatus.bootstrapping);

      // Attempting to transition baseline to READY throws ReadyStatusTransitionForbiddenError
      expect(
        () => reconciler.stateMachine.assertBaselineReadyTransitionForbidden(AuthoritativeBaselineStatus.ready),
        throwsA(isA<ReadyStatusTransitionForbiddenError>()),
      );
    });
  });
}
