import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
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
  late LocalLibraryDao localDao;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('omninovel_sync_dal_test_');
    dbPath = p.join(tempDir.path, 'sync_dal_test.db');
    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: dbPath,
      databaseFactory: databaseFactoryFfi,
      singleInstance: false,
    );
    dal = SyncStorageDal(offlineDatabase: offlineDb);
    localDao = LocalLibraryDao(offlineDatabase: offlineDb);
  });

  tearDown(() async {
    try {
      await offlineDb.close();
      await databaseFactoryFfi.deleteDatabase(dbPath);
    } catch (_) {}
    try {
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    } catch (_) {}
  });

  group('Atomic Local Write + Enqueue & Monotonic MAX History', () {
    test('recordReadingSessionWithMutation persists progress, monotonic MAX history, and enqueues FIFO without touching shadow replicas', () async {
      const scope = 'account:user-1';
      final admission = testAccountAdmission(scope);
      final t1 = DateTime.fromMillisecondsSinceEpoch(1730000000000, isUtc: true);
      final t2 = DateTime.fromMillisecondsSinceEpoch(1730000010000, isUtc: true);

      final progress1 = LocalReadingProgress(
        ownerScope: scope,
        storyId: 'story-1',
        chapterId: 'chap-1',
        chapterVersionId: 'ver-1',
        readingMode: 'MANGA_PAGED',
        progressPercentage: 92.0,
        scrollPosition: 0.0,
        pageIndex: 18,
        updatedAt: t1,
        deviceTimestamp: t1,
      );
      final history1 = LocalReadingHistory(
        ownerScope: scope,
        storyId: 'story-1',
        chapterId: 'chap-1',
        chapterVersionId: 'ver-1',
        storyTitle: 'Solo Leveling',
        chapterNumber: '1',
        progressPercentage: 92.0,
        lastReadAt: t1,
      );
      final mut1 = PendingMutationRecord.create(
        ownerScope: scope,
        mutationId: 'mut-session-1',
        clientId: kTestClientId,
        domain: SyncDomain.progress,
        entityId: 'story-1',
        operation: SyncOperation.upsert,
        baseServerRevision: '10',
        observedHistoryEpoch: 0,
        payload: buildSyncProgressPayload(progress1, observedHistoryEpoch: 0),
        createdAt: t1,
      );

      final saved1 = await dal.recordReadingSessionWithMutation(
        progress: progress1,
        history: history1,
        mutation: mut1,
        admission: admission,
      );
      expect(saved1.sequenceNo, 1);

      // M2 verification: local keeps MANGA_PAGED, sync payload normalizes to PAGED
      final localProg = await localDao.getProgress(ownerScope: scope, storyId: 'story-1');
      expect(localProg?.readingMode, 'MANGA_PAGED');
      expect(saved1.payload['readingMode'], 'PAGED');

      // Re-reading at lower 40% updates progress cursor but keeps history at Monotonic MAX 92%
      final progress2 = progress1.copyWith(progressPercentage: 40.0, pageIndex: 8, updatedAt: t2);
      final history2 = history1.copyWith(progressPercentage: 40.0, lastReadAt: t2);
      final mut2 = PendingMutationRecord.create(
        ownerScope: scope,
        mutationId: 'mut-session-2',
        clientId: kTestClientId,
        domain: SyncDomain.progress,
        entityId: 'story-1',
        operation: SyncOperation.upsert,
        baseServerRevision: '10',
        observedHistoryEpoch: 0,
        payload: buildSyncProgressPayload(progress2, observedHistoryEpoch: 0),
        createdAt: t2,
      );
      final saved2 = await dal.recordReadingSessionWithMutation(
        progress: progress2,
        history: history2,
        mutation: mut2,
        admission: admission,
      );
      expect(saved2.sequenceNo, 2);

      final localHist = await localDao.getHistoryItem(
        ownerScope: scope,
        storyId: 'story-1',
        chapterId: 'chap-1',
      );
      expect(localHist?.progressPercentage, 92.0);
      expect(await dal.getAllAuthoritativeShadows(scope), isEmpty);
    });

    test('bookmark, preference, story history delete, and global clearAllHistory atomic writes enforce invariants', () async {
      const scope = 'account:user-atomic-all';
      final admission = testAccountAdmission(scope);
      final t = DateTime.fromMillisecondsSinceEpoch(1730000100000, isUtc: true);

      // 1. Bookmark upsert & delete
      final bm = LocalBookmark(
        ownerScope: scope,
        storyId: 'story-bm-1',
        title: 'Story Bookmark',
        createdAt: t,
      );
      await dal.putBookmarkWithMutation(
        bookmark: bm,
        mutation: PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-bm-up',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-bm-1',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 'story-bm-1'},
          createdAt: t,
        ),
        admission: admission,
      );
      expect(await localDao.isBookmarked(ownerScope: scope, storyId: 'story-bm-1'), isTrue);

      // 2. Preference upsert
      await dal.putPreferenceWithMutation(
        preference: LocalPreferenceRecord(
          ownerScope: scope,
          prefKey: 'reader_theme',
          value: 'amoled',
          updatedAt: t.toIso8601String(),
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-pref-1',
          clientId: kTestClientId,
          domain: SyncDomain.preference,
          entityId: 'reader_theme',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'key': 'reader_theme', 'value': 'amoled'},
          createdAt: t,
        ),
        admission: admission,
      );
      expect((await dal.getAccountLocalPreference(scope, 'reader_theme'))?.value, 'amoled');

      // 3. Seed reading state for story-A and story-B
      for (final sId in <String>['story-A', 'story-B']) {
        await localDao.recordReadingSession(
          progress: LocalReadingProgress(
            ownerScope: scope,
            storyId: sId,
            chapterId: 'ch-1',
            progressPercentage: 50.0,
            scrollPosition: 100.0,
            updatedAt: t,
            deviceTimestamp: t,
          ),
          history: LocalReadingHistory(
            ownerScope: scope,
            storyId: sId,
            chapterId: 'ch-1',
            storyTitle: sId,
            chapterNumber: '1',
            progressPercentage: 50.0,
            lastReadAt: t,
          ),
        );
      }

      // Story-wide delete removes story-A only, preserving story-B & bookmark
      await dal.deleteStoryHistoryWithMutation(
        ownerScope: scope,
        storyId: 'story-A',
        mutation: PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-hist-del-A',
          clientId: kTestClientId,
          domain: SyncDomain.history,
          entityId: 'story-A',
          operation: SyncOperation.delete,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 'story-A'},
          createdAt: t,
        ),
        admission: admission,
      );
      expect(await localDao.getProgress(ownerScope: scope, storyId: 'story-A'), isNull);
      expect(await localDao.getProgress(ownerScope: scope, storyId: 'story-B'), isNotNull);
      expect(await localDao.isBookmarked(ownerScope: scope, storyId: 'story-bm-1'), isTrue);

      // Global clearAllHistory clears story-B while preserving bookmark
      await dal.clearAllHistoryWithMutation(
        ownerScope: scope,
        mutation: PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-hist-del-all',
          clientId: kTestClientId,
          domain: SyncDomain.history,
          entityId: kGlobalHistorySentinelUuid,
          operation: SyncOperation.delete,
          baseServerRevision: '0',
          payload: const <String, Object?>{},
          createdAt: t,
        ),
        admission: admission,
      );
      expect(await localDao.getHistory(ownerScope: scope), isEmpty);
      expect(await localDao.getProgress(ownerScope: scope, storyId: 'story-B'), isNull);
      expect(await localDao.isBookmarked(ownerScope: scope, storyId: 'story-bm-1'), isTrue);

      // Bookmark delete
      await dal.deleteBookmarkWithMutation(
        ownerScope: scope,
        storyId: 'story-bm-1',
        mutation: PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-bm-del',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-bm-1',
          operation: SyncOperation.delete,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 'story-bm-1'},
          createdAt: t,
        ),
        admission: admission,
      );
      expect(await localDao.isBookmarked(ownerScope: scope, storyId: 'story-bm-1'), isFalse);
    });

    test('duplicate mutationId triggers DuplicateMutationException and rolls back local write and sequence_no', () async {
      const scope = 'account:user-dup';
      final admission = testAccountAdmission(scope);
      final t = DateTime.fromMillisecondsSinceEpoch(1730000200000, isUtc: true);

      await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(
          ownerScope: scope,
          storyId: 'story-1',
          title: 'Story 1',
          createdAt: t,
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'dup-id-1',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-1',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 'story-1'},
          createdAt: t,
        ),
        admission: admission,
      );

      // Reuse same mutationId for story-2 -> must abort & roll back BOTH bookmark and sequence_no!
      await expectLater(
        () => dal.putBookmarkWithMutation(
          bookmark: LocalBookmark(
            ownerScope: scope,
            storyId: 'story-2',
            title: 'Should Rollback',
            createdAt: t,
          ),
          mutation: PendingMutationRecord.create(
            ownerScope: scope,
            mutationId: 'dup-id-1',
            clientId: kTestClientId,
            domain: SyncDomain.bookmark,
            entityId: 'story-2',
            operation: SyncOperation.upsert,
            baseServerRevision: '0',
            payload: const <String, Object?>{'storyId': 'story-2'},
            createdAt: t,
          ),
          admission: admission,
        ),
        throwsA(isA<DuplicateMutationException>()),
      );

      expect(await localDao.getBookmark(ownerScope: scope, storyId: 'story-2'), isNull);

      // Next valid mutation must receive sequenceNo == 2 (zero sequence leak from failed tx!)
      final next = await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(
          ownerScope: scope,
          storyId: 'story-3',
          title: 'Story 3',
          createdAt: t,
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'valid-id-2',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-3',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 'story-3'},
          createdAt: t,
        ),
        admission: admission,
      );
      expect(next.sequenceNo, 2);
    });

    test('onBeforeCommitHook failure rolls back local write, pending mutation, and sequence_no', () async {
      const scope = 'account:user-hook-rb';
      final admission = testAccountAdmission(scope);
      final t = DateTime.fromMillisecondsSinceEpoch(1730000300000, isUtc: true);

      await expectLater(
        () => dal.putPreferenceWithMutation(
          preference: LocalPreferenceRecord(
            ownerScope: scope,
            prefKey: 'font_size',
            value: 22,
            updatedAt: t.toIso8601String(),
          ),
          mutation: PendingMutationRecord.create(
            ownerScope: scope,
            mutationId: 'mut-hook-rb',
            clientId: kTestClientId,
            domain: SyncDomain.preference,
            entityId: 'font_size',
            operation: SyncOperation.upsert,
            baseServerRevision: '0',
            payload: const <String, Object?>{'key': 'font_size', 'value': 22},
            createdAt: t,
          ),
          admission: admission,
          onBeforeCommitHook: (_) async => throw StateError('Simulated crash before commit'),
        ),
        throwsStateError,
      );

      expect(await dal.getAccountLocalPreference(scope, 'font_size'), isNull);
      expect(await dal.getPendingMutations(scope), isEmpty);
      final seqRows = await offlineDb.database.query(
        'sync_mutation_sequences',
        where: 'owner_scope = ?',
        whereArgs: <Object?>[scope],
      );
      expect(seqRows, isEmpty);
    });
  });

  group('P1-M03: Durable Monotonic Mutation FIFO (sequence_no)', () {
    test('preserves strict insertion order across identical/regressive timestamps, empty queue drain, and DB restart', () async {
      const scope = 'account:user-fifo';
      final admission = testAccountAdmission(scope);
      final sameTime = DateTime.fromMillisecondsSinceEpoch(1730001000000, isUtc: true);
      final backwardsTime = DateTime.fromMillisecondsSinceEpoch(1729999000000, isUtc: true); // NTP jump back

      // Enqueue 3 mutations with non-chronological IDs & identical / backwards timestamps
      final mZ = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-z-first',
          clientId: kTestClientId,
          domain: SyncDomain.progress,
          entityId: 'story-1',
          operation: SyncOperation.upsert,
          baseServerRevision: '1',
          payload: const <String, Object?>{'chapterId': 'ch-1'},
          createdAt: sameTime,
        ),
        admission: admission,
      );
      final mA = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-a-second',
          clientId: kTestClientId,
          domain: SyncDomain.progress,
          entityId: 'story-1',
          operation: SyncOperation.upsert,
          baseServerRevision: '1',
          payload: const <String, Object?>{'chapterId': 'ch-2'},
          createdAt: sameTime,
        ),
        admission: admission,
      );
      final mM = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-m-third-ntp-back',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-1',
          operation: SyncOperation.delete,
          baseServerRevision: '1',
          payload: const <String, Object?>{'storyId': 'story-1'},
          createdAt: backwardsTime,
        ),
        admission: admission,
      );

      expect(<int>[mZ.sequenceNo, mA.sequenceNo, mM.sequenceNo], <int>[1, 2, 3]);

      final fifo1 = await dal.getPendingMutations(scope);
      expect(
        fifo1.map((m) => m.mutationId).toList(),
        <String>['mut-z-first', 'mut-a-second', 'mut-m-third-ntp-back'],
      );

      // Drain queue completely empty and restart DB
      await dal.deletePendingMutationsBatch(
        scope,
        fifo1.map((m) => m.mutationId).toList(),
        admission: admission,
      );
      expect(await dal.getPendingMutations(scope), isEmpty);

      await offlineDb.close();
      offlineDb = OfflineDatabase();
      await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );
      dal = SyncStorageDal(offlineDatabase: offlineDb);

      // Subsequent enqueue MUST allocate sequenceNo == 4 (never reset to 1)
      final m4 = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-post-restart',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-2',
          operation: SyncOperation.upsert,
          baseServerRevision: '5',
          payload: const <String, Object?>{'storyId': 'story-2'},
          createdAt: backwardsTime,
        ),
        admission: admission,
      );
      expect(m4.sequenceNo, 4);
    });
  });

  group('P1-M04: Transient Failure, Full-Fidelity Quarantine, Requeue & Eviction', () {
    test('recordTransientFailureAtomic computes backoff and preserves full metadata upon quarantine', () async {
      const scope = 'account:user-quarantine';
      final admission = testAccountAdmission(scope);
      final origTime = DateTime.fromMillisecondsSinceEpoch(1730002000123, isUtc: true);

      final pending = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-q-1',
          clientId: kTestClientIdAlt,
          domain: SyncDomain.history,
          entityId: 'story-9:chap-4',
          operation: SyncOperation.upsert,
          baseServerRevision: '42',
          observedHistoryEpoch: 7,
          payload: const <String, Object?>{'storyId': 'story-9', 'chapterId': 'chap-4', 'observedHistoryEpoch': 7},
          createdAt: origTime,
        ),
        admission: admission,
      );
      expect(pending.sequenceNo, 1);

      const opts = RecordTransientFailureOptions(
        maxRetries: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 5000,
        backoffFactor: 2.0,
        failureReason: '503 Service Unavailable',
      );

      // Retry 1
      final r1 = await dal.recordTransientFailureAtomic(
        ownerScope: scope,
        mutationId: 'mut-q-1',
        options: opts,
        admission: admission,
      );
      expect(r1.outcome, TransientFailureOutcome.retryScheduled);
      expect(r1.retryCount, 1);
      expect(r1.nextRetryAtMs, isNotNull);

      // Rollback check during retry 2 hook
      await expectLater(
        () => dal.recordTransientFailureAtomic(
          ownerScope: scope,
          mutationId: 'mut-q-1',
          options: RecordTransientFailureOptions(
            maxRetries: 3,
            initialBackoffMs: 1000,
            maxBackoffMs: 5000,
            backoffFactor: 2.0,
            failureReason: 'rollback test',
            onBeforeCommitHook: (_) async => throw StateError('abort'),
          ),
          admission: admission,
        ),
        throwsStateError,
      );
      expect((await dal.getPendingMutation(scope, 'mut-q-1'))?.retryCount, 1);

      // Retry 2
      final r2 = await dal.recordTransientFailureAtomic(
        ownerScope: scope,
        mutationId: 'mut-q-1',
        options: opts,
        admission: admission,
      );
      expect(r2.outcome, TransientFailureOutcome.retryScheduled);
      expect(r2.retryCount, 2);

      // Retry 3 hits maxRetries -> quarantined with full original metadata preserved
      final r3 = await dal.recordTransientFailureAtomic(
        ownerScope: scope,
        mutationId: 'mut-q-1',
        options: opts,
        admission: admission,
      );
      expect(r3.outcome, TransientFailureOutcome.quarantined);
      expect(r3.quarantinedMutation, isNotNull);

      expect(await dal.getPendingMutation(scope, 'mut-q-1'), isNull);
      final q = await dal.getQuarantinedMutation(scope, 'mut-q-1');
      expect(q, isNotNull);
      expect(q!.rejectionStatus, 'EXCEEDED_MAX_RETRIES');
      expect(q.originalSequenceNo, 1);
      expect(q.originalRetryCount, 2);
      expect(q.originalCreatedAtIso, origTime.toIso8601String());
      expect(q.originalCreatedAtMs, origTime.millisecondsSinceEpoch);
      expect(q.observedHistoryEpoch, 7);
      expect(q.baseServerRevision, '42');
      expect(q.triageStatus, QuarantineTriageStatus.pending);

      // Requeue allowed for EXCEEDED_MAX_RETRIES -> retryCount = 0, nextRetryAtMs = null, preserves original metadata
      final requeued = await dal.requeueQuarantinedMutation(
        ownerScope: scope,
        mutationId: 'mut-q-1',
        admission: admission,
      );
      expect(requeued.retryCount, 0);
      expect(requeued.nextRetryAtMs, isNull);
      expect(requeued.observedHistoryEpoch, 7);
      expect(requeued.createdAtIso, origTime.toIso8601String());
      expect(requeued.createdAtMs, origTime.millisecondsSinceEpoch);
      expect(await dal.getQuarantinedMutation(scope, 'mut-q-1'), isNull);

      // Test NOT_FOUND
      final notFound = await dal.recordTransientFailureAtomic(
        ownerScope: scope,
        mutationId: 'does-not-exist',
        options: opts,
        admission: admission,
      );
      expect(notFound.outcome, TransientFailureOutcome.notFound);
    });

    test('prohibits requeuing REJECTED_TOMBSTONE, REJECTED_STALE, and HTTP_410_GONE', () async {
      const scope = 'account:user-requeue-locks';
      final admission = testAccountAdmission(scope);
      final t = DateTime.fromMillisecondsSinceEpoch(1730003000000, isUtc: true);

      for (final status in <String>['REJECTED_TOMBSTONE', 'REJECTED_STALE', 'HTTP_410_GONE']) {
        final mutId = 'mut-$status';
        await dal.enqueuePendingMutation(
          PendingMutationRecord.create(
            ownerScope: scope,
            mutationId: mutId,
            clientId: kTestClientId,
            domain: SyncDomain.history,
            entityId: 'story-1:chap-1',
            operation: SyncOperation.upsert,
            baseServerRevision: '10',
            observedHistoryEpoch: 1,
            payload: const <String, Object?>{'storyId': 'story-1', 'chapterId': 'chap-1'},
            createdAt: t,
          ),
          admission: admission,
        );
        await dal.quarantinePendingMutationByKey(
          ownerScope: scope,
          mutationId: mutId,
          reason: 'Blocked by $status',
          status: status,
          causalEvidence: const CausalTriageProof(
            observedEpoch: 1,
            validatedRevision: '15',
            triageApproved: false,
            triageReason: 'Epoch mismatch',
          ),
          admission: admission,
        );

        await expectLater(
          () => dal.requeueQuarantinedMutation(
            ownerScope: scope,
            mutationId: mutId,
            admission: admission,
          ),
          throwsA(isA<RequeueProhibitedError>()),
        );
        expect(await dal.getQuarantinedMutation(scope, mutId), isNotNull);
      }
    });

    test('evictReplicaAndRemovePending atomically clears local/shadow replicas and removes pending mutation', () async {
      const scope = 'account:user-evict';
      final admission = testAccountAdmission(scope);
      final t = DateTime.fromMillisecondsSinceEpoch(1730004000000, isUtc: true);

      final bm = LocalBookmark(ownerScope: scope, storyId: 'story-bm', title: 'BM', createdAt: t);
      await dal.putBookmarkWithMutation(
        bookmark: bm,
        mutation: PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-bm-evict',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 'story-bm',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 'story-bm'},
          createdAt: t,
        ),
        admission: admission,
      );

      // Hook failure must leave BOTH bookmark and pending mutation intact
      await expectLater(
        () => dal.evictReplicaAndRemovePending(
          ownerScope: scope,
          domain: SyncDomain.bookmark,
          entityId: 'story-bm',
          mutationId: 'mut-bm-evict',
          admission: admission,
          onBeforeCommitHook: (_) async => throw StateError('fail eviction'),
        ),
        throwsStateError,
      );
      expect(await localDao.isBookmarked(ownerScope: scope, storyId: 'story-bm'), isTrue);
      expect(await dal.getPendingMutation(scope, 'mut-bm-evict'), isNotNull);

      // Successful eviction clears both atomically
      await dal.evictReplicaAndRemovePending(
        ownerScope: scope,
        domain: SyncDomain.bookmark,
        entityId: 'story-bm',
        mutationId: 'mut-bm-evict',
        admission: admission,
      );
      expect(await localDao.isBookmarked(ownerScope: scope, storyId: 'story-bm'), isFalse);
      expect(await dal.getPendingMutation(scope, 'mut-bm-evict'), isNull);
    });
  });

  group('P1-M04 Snapshot Staging & P0-M05 Scope-Safe Purge', () {
    test('stageSnapshotItems enforces uniform snapshotRevision per (ownerScope, sessionId)', () async {
      const scope = 'account:user-snap';
      final admission = testAccountAdmission(scope);
      const nowIso = '2026-01-01T00:00:00.000Z';

      await dal.stageSnapshotItems(
        ownerScope: scope,
        admission: admission,
        items: const <SnapshotStagingItem>[
          SnapshotStagingItem(
            ownerScope: scope,
            sessionId: 'sess-1',
            snapshotRevision: '200',
            minActiveRevision: '150',
            cursorToken: 'cursor-p2',
            pageIndex: 0,
            domain: SyncDomain.bookmark,
            entityKey: 'story-1',
            payload: <String, Object?>{'storyId': 'story-1'},
            stagedAtIso: nowIso,
            stagedAtMs: 1000,
          ),
        ],
      );

      // Staging another page with conflicting snapshotRevision MUST throw SnapshotStagingConflictError
      await expectLater(
        () => dal.stageSnapshotItems(
          ownerScope: scope,
          admission: admission,
          items: const <SnapshotStagingItem>[
            SnapshotStagingItem(
              ownerScope: scope,
              sessionId: 'sess-1',
              snapshotRevision: '201',
              minActiveRevision: '150',
              cursorToken: null,
              pageIndex: 1,
              domain: SyncDomain.bookmark,
              entityKey: 'story-2',
              payload: <String, Object?>{'storyId': 'story-2'},
              stagedAtIso: nowIso,
              stagedAtMs: 1001,
            ),
          ],
        ),
        throwsA(isA<SnapshotStagingConflictError>()),
      );

      final staged = await dal.getSnapshotStagingItems(scope, 'sess-1');
      expect(staged, hasLength(1));
      expect(staged.first.entityKey, 'story-1');

      await dal.clearSnapshotStaging(scope, sessionId: 'sess-1', admission: admission);
      expect(await dal.getSnapshotStagingItems(scope, 'sess-1'), isEmpty);
    });

    test('purgeAccountScope deletes only target scope tables and preserves offline_chapters, download_tasks, tombstones, recovery journal, and other scopes', () async {
      const targetScope = 'account:user-purge-target';
      const otherScope = 'guest:guest-safe';
      final targetAdmission = testAccountAdmission(targetScope);
      final otherGuestAdmission = testGuestAdmission(otherScope);
      final db = offlineDb.database;
      final t = DateTime.fromMillisecondsSinceEpoch(1730005000000, isUtc: true);

      // Seed preserved tables (v2 & v4)
      await db.insert('offline_chapters', <String, Object?>{
        'chapter_version_id': 'cv-safe',
        'user_id': 'user-purge-target',
        'chapter_id': 'c-1',
        'story_id': 's-1',
        'story_title': 'Offline Safe',
        'chapter_number': '1',
        'media_format': 'WEBTOON',
        'installed_dir': '/safe/dir',
        'total_files': 5,
        'total_bytes': 1234,
        'installed_at': 1000,
        'manifest_json': '{}',
      });
      await db.insert('download_tasks', <String, Object?>{
        'task_id': 'task-safe',
        'user_id': 'user-purge-target',
        'chapter_version_id': 'cv-safe-2',
        'chapter_id': 'c-2',
        'story_id': 's-1',
        'story_title': 'Offline Safe',
        'chapter_number': '2',
        'media_format': 'WEBTOON',
        'status': 'COMPLETED',
        'created_at': 1000,
        'updated_at': 1000,
      });
      await db.insert('offline_deletion_tombstones', <String, Object?>{
        'tombstone_id': 'tb-safe',
        'user_id': 'user-purge-target',
        'chapter_version_id': 'cv-old',
        'created_at': 1000,
      });
      await db.insert('guest_claim_recovery_journal', <String, Object?>{
        'claim_id': 'claim-safe',
        'user_id': 'user-purge-target',
        'guest_profile_id': 'guest-safe',
        'expected_state_fingerprint': 'fp',
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'created_at': 1000,
        'updated_at': 1000,
      });

      // Seed targetScope across sync + local tables
      await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(ownerScope: targetScope, storyId: 's-target', title: 'Target', createdAt: t),
        mutation: PendingMutationRecord.create(
          ownerScope: targetScope,
          mutationId: 'mut-t1',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 's-target',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 's-target'},
          createdAt: t,
        ),
        admission: targetAdmission,
      );
      await dal.putPreferenceWithMutation(
        preference: LocalPreferenceRecord(
          ownerScope: targetScope,
          prefKey: 'theme',
          value: 'dark',
          updatedAt: t.toIso8601String(),
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: targetScope,
          mutationId: 'mut-pref-t1',
          clientId: kTestClientId,
          domain: SyncDomain.preference,
          entityId: 'theme',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'key': 'theme', 'value': 'dark'},
          createdAt: t,
        ),
        admission: targetAdmission,
      );
      await dal.setAuthoritativeBaselineStatus(
        targetScope,
        AuthoritativeBaselineStatus.bootstrapping,
        admission: targetAdmission,
      );

      // Seed otherScope (Guest-local)
      await localDao.saveBookmark(
        LocalBookmark(ownerScope: otherScope, storyId: 's-other', title: 'Other', createdAt: t),
      );
      await dal.putGuestLocalPreference(
        LocalPreferenceRecord(
          ownerScope: otherScope,
          prefKey: 'theme',
          value: 'light',
          updatedAt: t.toIso8601String(),
        ),
        admission: otherGuestAdmission,
      );

      // R-03 fail-closed default (discardUnsyncedMutations: false): blocks delete while pending_mutations exist
      await expectLater(
        () => dal.purgeAccountScope(
          ownerScope: targetScope,
          reason: AccountPurgeReason.accountDeleted,
          admission: targetAdmission,
        ),
        throwsA(
          isA<PurgeProhibitedError>().having(
            (e) => e.message,
            'message',
            contains('UNSYNCED_MUTATIONS_PRESENT'),
          ),
        ),
      );
      expect(await dal.getSyncMeta(targetScope), isNotNull);
      expect(await dal.getPendingMutations(targetScope), hasLength(2));
      expect((await dal.getAccountLocalPreference(targetScope, 'theme'))?.value, 'dark');
      expect(await localDao.isBookmarked(ownerScope: targetScope, storyId: 's-target'), isTrue);

      // Explicit confirmed wipe (discardUnsyncedMutations: true) wipes target scope only
      await dal.purgeAccountScope(
        ownerScope: targetScope,
        reason: AccountPurgeReason.accountDeleted,
        admission: targetAdmission,
        discardUnsyncedMutations: true,
      );

      // Target scope wiped
      expect(await dal.getSyncMeta(targetScope), isNull);
      expect(await dal.getPendingMutations(targetScope), isEmpty);
      expect(await dal.getAccountLocalPreference(targetScope, 'theme'), isNull);
      expect(await localDao.getBookmarks(ownerScope: targetScope), isEmpty);

      // Other scope & disk/journal tables preserved 100%
      expect(await localDao.isBookmarked(ownerScope: otherScope, storyId: 's-other'), isTrue);
      expect((await dal.getGuestLocalPreference(otherScope, 'theme'))?.value, 'light');
      expect(await db.query('offline_chapters'), hasLength(1));
      expect(await db.query('download_tasks'), hasLength(1));
      expect(await db.query('offline_deletion_tombstones'), hasLength(1));
      expect(await db.query('guest_claim_recovery_journal'), hasLength(1));
    });
  });
}
