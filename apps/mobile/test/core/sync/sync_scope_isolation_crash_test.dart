import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/storage/sync_storage_dal.dart';
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
  late SyncStorageDal dal;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('omninovel_sync_scope_test_');
    dbPath = p.join(tempDir.path, 'sync_scope_test.db');
    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: dbPath,
      databaseFactory: databaseFactoryFfi,
      singleInstance: false,
    );
    dal = SyncStorageDal(offlineDatabase: offlineDb);
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

  group('Fail-Closed Baseline Lifecycle & Crash Recovery', () {
    test('defaults new and non-zero checkpoint scopes to UNINITIALIZED and forbids READY transitions in Stage 1', () async {
      const scope = 'account:baseline-lock';

      // Default unseeded scope
      expect(await dal.getAuthoritativeBaselineStatus(scope), AuthoritativeBaselineStatus.uninitialized);
      expect(await dal.isAuthoritativeReady(scope), isFalse);

      // Scope with non-zero revision via putSyncMeta stays UNINITIALIZED
      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: scope,
          lastSyncedServerRevision: '42',
          minActiveRevision: '10',
          lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
        ),
      );
      expect(await dal.getAuthoritativeBaselineStatus(scope), AuthoritativeBaselineStatus.uninitialized);
      expect(await dal.isAuthoritativeReady(scope), isFalse);

      // Direct setAuthoritativeBaselineStatus(READY) is forbidden
      await expectLater(
        () => dal.setAuthoritativeBaselineStatus(scope, AuthoritativeBaselineStatus.ready),
        throwsA(isA<ReadyStatusTransitionForbiddenError>()),
      );

      // Elevation via putSyncMeta(READY) is forbidden
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: scope,
            lastSyncedServerRevision: '42',
            minActiveRevision: '10',
            lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
            authoritativeBaselineStatus: AuthoritativeBaselineStatus.ready,
          ),
        ),
        throwsA(isA<ReadyStatusTransitionForbiddenError>()),
      );

      expect(await dal.isAuthoritativeReady(scope), isFalse);
    });

    test('forbids mutating checkpoint, minActiveRevision, or epochs on a READY scope via putSyncMeta, while allowing operational telemetry updates', () async {
      const scope = 'account:ready-immutable';

      // Seed a pre-existing verified READY row directly in SQLite (no production backdoor exists)
      await offlineDb.database.insert('sync_meta', <String, Object?>{
        'owner_scope': scope,
        'last_synced_server_revision': '150',
        'min_active_revision': '100',
        'last_sync_timestamp': '2026-01-01T00:00:00.000Z',
        'effective_history_epochs_json': '{"s1":2,"s2":5}',
        'sync_state': 'IDLE',
        'authoritative_baseline_status': 'READY',
        'last_error_message': null,
      });

      // Attempt checkpoint tampering -> blocked
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: scope,
            lastSyncedServerRevision: '160',
            minActiveRevision: '100',
            lastSyncTimestamp: '2026-01-01T00:01:00.000Z',
            effectiveHistoryEpochs: <String, int>{'s1': 2, 's2': 5},
            authoritativeBaselineStatus: AuthoritativeBaselineStatus.ready,
          ),
        ),
        throwsA(isA<ReadyStatusTransitionForbiddenError>().having(
          (e) => e.message,
          'message',
          contains('CHECKPOINT_MUTATION_FORBIDDEN'),
        )),
      );

      // Attempt minActiveRevision tampering -> blocked
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: scope,
            lastSyncedServerRevision: '150',
            minActiveRevision: '120',
            lastSyncTimestamp: '2026-01-01T00:01:00.000Z',
            effectiveHistoryEpochs: <String, int>{'s1': 2, 's2': 5},
            authoritativeBaselineStatus: AuthoritativeBaselineStatus.ready,
          ),
        ),
        throwsA(isA<ReadyStatusTransitionForbiddenError>()),
      );

      // Attempt effectiveHistoryEpochs tampering -> blocked
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: scope,
            lastSyncedServerRevision: '150',
            minActiveRevision: '100',
            lastSyncTimestamp: '2026-01-01T00:01:00.000Z',
            effectiveHistoryEpochs: <String, int>{'s1': 3, 's2': 5},
            authoritativeBaselineStatus: AuthoritativeBaselineStatus.ready,
          ),
        ),
        throwsA(isA<ReadyStatusTransitionForbiddenError>()),
      );

      // Benign operational update with same epochs in reversed key order MUST succeed!
      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: scope,
          lastSyncedServerRevision: '150',
          minActiveRevision: '100',
          lastSyncTimestamp: '2026-01-01T00:02:00.000Z',
          effectiveHistoryEpochs: <String, int>{'s2': 5, 's1': 2},
          syncState: SyncExecutionState.error,
          authoritativeBaselineStatus: AuthoritativeBaselineStatus.ready,
          lastErrorMessage: 'Network timeout',
        ),
      );
      final updated = await dal.getSyncMeta(scope);
      expect(updated?.syncState, SyncExecutionState.error);
      expect(updated?.lastErrorMessage, 'Network timeout');
    });

    test('crash recovery resets interrupted BOOTSTRAPPING back to UNINITIALIZED across DB reopen without losing checkpoint', () async {
      const scope = 'account:crash-recovery';

      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: scope,
          lastSyncedServerRevision: '55',
          minActiveRevision: '10',
          lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
          effectiveHistoryEpochs: <String, int>{'story-9': 3},
          syncState: SyncExecutionState.reconciling410,
        ),
      );
      await dal.setAuthoritativeBaselineStatus(scope, AuthoritativeBaselineStatus.bootstrapping);
      expect(await dal.getAuthoritativeBaselineStatus(scope), AuthoritativeBaselineStatus.bootstrapping);
      expect(await dal.isAuthoritativeReady(scope), isFalse);

      // Simulate crash -> close & reopen database
      await offlineDb.close();
      offlineDb = OfflineDatabase();
      await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );
      dal = SyncStorageDal(offlineDatabase: offlineDb);

      expect(await dal.getAuthoritativeBaselineStatus(scope), AuthoritativeBaselineStatus.bootstrapping);

      final recovered = await dal.recoverInterruptedBootstrapToUninitialized(scope);
      expect(recovered, isTrue);

      final postRecovery = await dal.getSyncMeta(scope);
      expect(postRecovery?.authoritativeBaselineStatus, AuthoritativeBaselineStatus.uninitialized);
      expect(postRecovery?.syncState, SyncExecutionState.idle);
      expect(postRecovery?.lastSyncedServerRevision, '55');
      expect(postRecovery?.effectiveHistoryEpochs, <String, int>{'story-9': 3});

      // Calling recovery on non-bootstrapping or READY returns false cleanly
      expect(await dal.recoverInterruptedBootstrapToUninitialized(scope), isFalse);
      expect(await dal.recoverInterruptedBootstrapToUninitialized('account:missing'), isFalse);
    });
  });

  group('P0-M02 Triple-Barrier Admission & Multi-Tenant Scope Isolation', () {
    test('pre-transaction and pre-commit checkAdmission aborts rollback 100% of writes without dirty shadows or sequence leaks', () async {
      const scope = 'account:admission-guard';
      var activeScope = scope;
      var generation = 1;
      const expectedGen = 1;

      void guard() {
        if (activeScope != scope || generation != expectedGen) {
          throw const SyncAdmissionRejectedError(
            'Scope or generation invalidated mid-flight.',
          );
        }
      }

      // 1. Pre-transaction barrier blocks before touching DB
      generation = 2;
      await expectLater(
        () => dal.putBookmarkWithMutation(
          bookmark: LocalBookmark(
            ownerScope: scope,
            storyId: 's-blocked',
            title: 'Blocked',
            createdAt: DateTime.utc(2026),
          ),
          mutation: PendingMutationRecord.create(
            ownerScope: scope,
            mutationId: 'mut-blocked-1',
            clientId: 'cli-1',
            domain: SyncDomain.bookmark,
            entityId: 's-blocked',
            operation: SyncOperation.upsert,
            baseServerRevision: '0',
            payload: const <String, Object?>{'storyId': 's-blocked'},
          ),
          checkAdmission: guard,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // 2. Pre-commit seal barrier (Barrier 3): generation flips right before commit inside txn!
      generation = 1;
      await expectLater(
        () => dal.applyAuthoritativeDeltaPage(
          ownerScope: scope,
          expectedCheckpoint: '0',
          page: SyncChangesPage(
            currentServerRevision: '88',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: <SyncChangeItem>[
              SyncChangeItem.typed(
                revision: '88',
                domain: SyncDomain.bookmark,
                entityId: 'story-dirty-on-logout',
                operation: SyncOperation.upsert,
              ),
            ],
          ),
          checkAdmission: guard,
          onBeforeCommitHook: (_) async {
            // Simulate user logging out during async disk transaction before commit seal!
            activeScope = 'guest:new-rotated-guest';
            generation = 99;
          },
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // Verify ZERO dirty writes landed
      expect(await dal.getSyncMeta(scope), isNull);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-dirty-on-logout'), isNull);
      expect(await dal.getPendingMutations(scope), isEmpty);
    });

    test('strictly isolates guest:*, account:A, and account:B and rejects malformed scopes', () async {
      const guestScope = 'guest:g-iso-1';
      const accountA = 'account:usr-A';
      const accountB = 'account:usr-B';
      final t = DateTime.utc(2026, 1, 1);

      for (final invalid in <String?>['', '   ', 'anon', 'guest:', 'account:', ' account:a', 'device:123']) {
        await expectLater(
          () => dal.getSyncMeta(invalid ?? ''),
          throwsA(isA<InvalidSyncScopeException>()),
        );
      }

      // Account A & B delta + pending + preference + guest preference coexist cleanly
      await dal.applyAuthoritativeDeltaPage(
        ownerScope: accountA,
        expectedCheckpoint: '0',
        page: SyncChangesPage(
          currentServerRevision: '10',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '10',
              domain: SyncDomain.bookmark,
              entityId: 'story-shared-id',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'owner': 'A'},
            ),
          ],
        ),
      );
      await dal.applyAuthoritativeDeltaPage(
        ownerScope: accountB,
        expectedCheckpoint: '0',
        page: SyncChangesPage(
          currentServerRevision: '20',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '20',
              domain: SyncDomain.bookmark,
              entityId: 'story-shared-id',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'owner': 'B'},
            ),
          ],
        ),
      );
      await dal.putPreference(
        LocalPreferenceRecord(
          ownerScope: guestScope,
          prefKey: 'reader_bg',
          value: 'sepia',
          updatedAt: t.toIso8601String(),
        ),
      );

      expect((await dal.getSyncMeta(accountA))?.lastSyncedServerRevision, '10');
      expect((await dal.getSyncMeta(accountB))?.lastSyncedServerRevision, '20');
      expect(await dal.getSyncMeta(guestScope), isNull);

      expect((await dal.getAuthoritativeShadow(accountA, SyncDomain.bookmark, 'story-shared-id'))?.payload?['owner'], 'A');
      expect((await dal.getAuthoritativeShadow(accountB, SyncDomain.bookmark, 'story-shared-id'))?.payload?['owner'], 'B');
      expect((await dal.getPreference(guestScope, 'reader_bg'))?.value, 'sepia');
      expect(await dal.getPreference(accountA, 'reader_bg'), isNull);
    });
  });
}
