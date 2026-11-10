import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/sync/authority/sync_write_admission.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/reconciler/mock_sync_transport.dart';
import 'package:omninovel_mobile/core/sync/reconciler/offline_reconciler_state.dart';
import 'package:omninovel_mobile/core/sync/reconciler/offline_sync_reconciler.dart';
import 'package:omninovel_mobile/core/sync/reconciler/sync_receipt_validator.dart';
import 'package:omninovel_mobile/core/sync/storage/sync_storage_dal.dart';
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
    tempDir = await Directory.systemTemp.createTemp('receipt_safety_');
    dbPath = p.join(tempDir.path, 'receipt_safety.db');
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

  const scopeA = 'account:user-receipt-alpha';
  const scopeB = 'account:user-receipt-beta';

  PendingMutationRecord createSampleMutation({
    required String ownerScope,
    required String mutationId,
    required String storyId,
    String baseServerRevision = '10',
    Map<String, Object?>? payload,
  }) {
    return PendingMutationRecord.create(
      ownerScope: ownerScope,
      mutationId: mutationId,
      clientId: kTestClientId,
      domain: SyncDomain.bookmark,
      entityId: storyId,
      operation: SyncOperation.upsert,
      baseServerRevision: baseServerRevision,
      payload: payload ?? {'storyId': storyId, 'title': 'Test Story'},
    );
  }

  Future<void> seedBookmarkWithMutation(
    PendingMutationRecord mutation,
    AccountWriteAdmission admission,
  ) async {
    await dal.putBookmarkWithMutation(
      bookmark: LocalBookmark(
        ownerScope: mutation.ownerScope,
        storyId: mutation.entityId,
        title: 'Bookmark ${mutation.entityId}',
        createdAt: DateTime.now().toUtc(),
      ),
      mutation: mutation,
      admission: admission,
    );
  }

  // =========================================================================
  // GROUP 1: In-Memory Receipt Integrity Validation (SyncReceiptValidator)
  // =========================================================================
  group('Mobile Stage 2A.1 — Group 1: Receipt Integrity Validation Tests', () {
    const wireMut1 = ClientMutationWire(
      clientId: kTestClientId,
      mutationId: 'mut-rec-01',
      domain: 'BOOKMARK',
      entityId: 'story-01',
      operation: 'UPSERT',
      baseServerRevision: '10',
      payload: {'storyId': 'story-01'},
    );
    const wireMut2 = ClientMutationWire(
      clientId: kTestClientId,
      mutationId: 'mut-rec-02',
      domain: 'BOOKMARK',
      entityId: 'story-02',
      operation: 'UPSERT',
      baseServerRevision: '10',
      payload: {'storyId': 'story-02'},
    );

    test('1. Valid batch response with APPLIED and DEDUPLICATED passes validation', () {
      expect(
        () => SyncReceiptValidator.validate(
          sentMutations: const [wireMut1, wireMut2],
          response: const PushMutationsBatchResponseWire(
            processedCount: 2,
            newServerRevision: '102',
            results: [
              MutationResultItemWire(
                mutationId: 'mut-rec-01',
                status: 'APPLIED',
                assignedRevision: '101',
              ),
              MutationResultItemWire(
                mutationId: 'mut-rec-02',
                status: 'DEDUPLICATED',
                assignedRevision: '100',
              ),
            ],
          ),
        ),
        returnsNormally,
      );
    });

    test('2. Missing receipt (count mismatch) throws ReceiptValidationException', () {
      expect(
        () => SyncReceiptValidator.validate(
          sentMutations: const [wireMut1, wireMut2],
          response: const PushMutationsBatchResponseWire(
            processedCount: 2,
            newServerRevision: '102',
            results: [
              MutationResultItemWire(
                mutationId: 'mut-rec-01',
                status: 'APPLIED',
                assignedRevision: '101',
              ),
            ],
          ),
        ),
        throwsA(
          isA<ReceiptValidationException>().having(
            (e) => e.message,
            'message',
            contains('RECEIPT_COUNT_MISMATCH'),
          ),
        ),
      );
    });

    test('3. ProcessedCount mismatch throws ReceiptValidationException', () {
      expect(
        () => SyncReceiptValidator.validate(
          sentMutations: const [wireMut1, wireMut2],
          response: const PushMutationsBatchResponseWire(
            processedCount: 1, // Mismatch with sent length (2)
            newServerRevision: '102',
            results: [
              MutationResultItemWire(
                mutationId: 'mut-rec-01',
                status: 'APPLIED',
                assignedRevision: '101',
              ),
              MutationResultItemWire(
                mutationId: 'mut-rec-02',
                status: 'APPLIED',
                assignedRevision: '102',
              ),
            ],
          ),
        ),
        throwsA(
          isA<ReceiptValidationException>().having(
            (e) => e.message,
            'message',
            contains('PROCESSED_COUNT_MISMATCH'),
          ),
        ),
      );
    });

    test('4. Unexpected mutationId not in sent batch throws ReceiptValidationException', () {
      expect(
        () => SyncReceiptValidator.validate(
          sentMutations: const [wireMut1],
          response: const PushMutationsBatchResponseWire(
            processedCount: 1,
            newServerRevision: '102',
            results: [
              MutationResultItemWire(
                mutationId: 'mut-ghost-alien',
                status: 'APPLIED',
                assignedRevision: '101',
              ),
            ],
          ),
        ),
        throwsA(
          isA<ReceiptValidationException>().having(
            (e) => e.message,
            'message',
            contains('UNEXPECTED_MUTATION_ID'),
          ),
        ),
      );
    });

    test('5. Duplicate mutationId in results list throws ReceiptValidationException', () {
      expect(
        () => SyncReceiptValidator.validate(
          sentMutations: const [wireMut1, wireMut2],
          response: const PushMutationsBatchResponseWire(
            processedCount: 2,
            newServerRevision: '102',
            results: [
              MutationResultItemWire(
                mutationId: 'mut-rec-01',
                status: 'APPLIED',
                assignedRevision: '101',
              ),
              MutationResultItemWire(
                mutationId: 'mut-rec-01', // Duplicate
                status: 'APPLIED',
                assignedRevision: '102',
              ),
            ],
          ),
        ),
        throwsA(
          isA<ReceiptValidationException>().having(
            (e) => e.message,
            'message',
            contains('DUPLICATE_RECEIPT'),
          ),
        ),
      );
    });

    test('6. Empty or whitespace mutationId throws ReceiptValidationException', () {
      expect(
        () => SyncReceiptValidator.validate(
          sentMutations: const [wireMut1],
          response: const PushMutationsBatchResponseWire(
            processedCount: 1,
            newServerRevision: '102',
            results: [
              MutationResultItemWire(
                mutationId: '   ',
                status: 'APPLIED',
                assignedRevision: '101',
              ),
            ],
          ),
        ),
        throwsA(
          isA<ReceiptValidationException>().having(
            (e) => e.message,
            'message',
            contains('EMPTY_MUTATION_ID'),
          ),
        ),
      );
    });

    test('7. Invalid newServerRevision (non-numeric, negative, leading zero) throws ReceiptValidationException', () {
      final invalidRevisions = ['-5', 'abc', '012', '999999999999999999999999999999'];
      for (final rev in invalidRevisions) {
        expect(
          () => SyncReceiptValidator.validate(
            sentMutations: const [wireMut1],
            response: PushMutationsBatchResponseWire(
              processedCount: 1,
              newServerRevision: rev,
              results: const [
                MutationResultItemWire(
                  mutationId: 'mut-rec-01',
                  status: 'APPLIED',
                  assignedRevision: '101',
                ),
              ],
            ),
          ),
          throwsA(
            isA<ReceiptValidationException>().having(
              (e) => e.message,
              'message',
              contains('INVALID_SERVER_REVISION'),
            ),
          ),
        );
      }
    });

    test('8. Missing or malformed assignedRevision on APPLIED throws ReceiptValidationException', () {
      expect(
        () => SyncReceiptValidator.validate(
          sentMutations: const [wireMut1],
          response: const PushMutationsBatchResponseWire(
            processedCount: 1,
            newServerRevision: '102',
            results: [
              MutationResultItemWire(
                mutationId: 'mut-rec-01',
                status: 'APPLIED',
                assignedRevision: null, // Prohibited for APPLIED
              ),
            ],
          ),
        ),
        throwsA(
          isA<ReceiptValidationException>().having(
            (e) => e.message,
            'message',
            contains('INVALID_ASSIGNED_REVISION'),
          ),
        ),
      );
    });

    test('9. Unrecognized status (UNKNOWN_STATUS) throws ReceiptValidationException and does NOT quarantine', () {
      expect(
        () => SyncReceiptValidator.validate(
          sentMutations: const [wireMut1],
          response: const PushMutationsBatchResponseWire(
            processedCount: 1,
            newServerRevision: '102',
            results: [
              MutationResultItemWire(
                mutationId: 'mut-rec-01',
                status: 'UNKNOWN_SERVER_STATUS',
                assignedRevision: '101',
              ),
            ],
          ),
        ),
        throwsA(
          isA<ReceiptValidationException>().having(
            (e) => e.message,
            'message',
            contains('UNRECOGNIZED_RECEIPT_STATUS'),
          ),
        ),
      );
    });
  });

  // =========================================================================
  // GROUP 2: Protocol Status Alignment & Settlement
  // =========================================================================
  group('Mobile Stage 2A.1 — Group 2: Protocol Status Alignment Tests', () {
    final admissionA = testAccountAdmission(scopeA);

    test('10. CONFLICT_MERGED settles pending mutation, does NOT quarantine, and pulls delta', () async {
      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
      );

      final mut = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-conflict-01',
        storyId: 'story-conflict-01',
      );
      await seedBookmarkWithMutation(mut, admissionA);

      // Verify pending mutation is queued
      final pendingBefore = await dal.getPendingMutations(scopeA);
      expect(pendingBefore.length, 1);
      expect(pendingBefore.first.mutationId, 'mut-conflict-01');

      // Setup transport to return CONFLICT_MERGED
      transport.customPushHandler = (ownerScope, mutations) async {
        return const PushMutationsBatchResponseWire(
          processedCount: 1,
          newServerRevision: '150',
          results: [
            MutationResultItemWire(
              mutationId: 'mut-conflict-01',
              status: 'CONFLICT_MERGED',
              assignedRevision: '150',
              message: 'Server higher progress preserved under monotonic forward',
            ),
          ],
        );
      };

      // Also setup changes delta to simulate server resolved state
      transport.customChangesHandler = (ownerScope, afterRevision, limit) async {
        return SyncChangesPage(
          currentServerRevision: '150',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            SyncChangeItem.typed(
              revision: '150',
              domain: SyncDomain.bookmark,
              entityId: 'story-conflict-01',
              operation: SyncOperation.upsert,
              payload: const {'storyId': 'story-conflict-01', 'title': 'Merged Story'},
            ),
          ],
        );
      };

      final result = await reconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: admissionA,
      );

      expect(result.finalState, OfflineReconcilerState.idle);
      expect(result.mutationsPushed, 1);
      expect(result.mutationsQuarantined, 0); // NOT quarantined!
      expect(result.deltasApplied, 1);

      // Verify pending mutations are completely deleted
      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter, isEmpty);

      // Verify quarantine store is completely empty
      final quarantined = await dal.getQuarantinedMutations(scopeA);
      expect(quarantined, isEmpty);

      // Verify authoritative shadow replica was updated from delta
      final shadow = await dal.getAuthoritativeShadow(
        scopeA,
        SyncDomain.bookmark,
        'story-conflict-01',
      );
      expect(shadow, isNotNull);
      expect(shadow!.serverRevision, '150');
      expect(shadow.payload?['title'], 'Merged Story');
    });

    test('11. REJECTED_TOMBSTONE moves mutation to quarantine with causal proof & full payload', () async {
      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
      );

      final originalPayload = <String, Object?>{
        'storyId': 'story-tomb-01',
        'title': 'Original Unmodified Title',
        'extraMeta': 'Important User Note',
      };
      final mut = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-tomb-01',
        storyId: 'story-tomb-01',
        payload: originalPayload,
      );
      await seedBookmarkWithMutation(mut, admissionA);

      transport.customPushHandler = (ownerScope, mutations) async {
        return const PushMutationsBatchResponseWire(
          processedCount: 1,
          newServerRevision: '160',
          results: [
            MutationResultItemWire(
              mutationId: 'mut-tomb-01',
              status: 'REJECTED_TOMBSTONE',
              assignedRevision: '159',
              reason: 'Entity has been permanently deleted on server',
            ),
          ],
        );
      };

      final result = await reconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: admissionA,
      );

      expect(result.finalState, OfflineReconcilerState.idle);
      expect(result.mutationsPushed, 0);
      expect(result.mutationsQuarantined, 1);

      // Pending queue is cleared
      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter, isEmpty);

      // Quarantine store has the exact record
      final quarantined = await dal.getQuarantinedMutations(scopeA);
      expect(quarantined.length, 1);
      final qRec = quarantined.first;
      expect(qRec.mutationId, 'mut-tomb-01');
      expect(qRec.rejectionStatus, 'REJECTED_TOMBSTONE');
      expect(qRec.rejectionReason, contains('Entity has been permanently deleted'));
      expect(qRec.causalEvidence, isNotNull);
      expect(qRec.causalEvidence!.validatedRevision, '159');
      // Full fidelity payload preserved
      expect(qRec.payload, equals(originalPayload));
    });

    test('12. Mixed batch (APPLIED + CONFLICT_MERGED + REJECTED_STALE) settles atomically', () async {
      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
      );

      final mut1 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-mix-01',
        storyId: 'story-mix-01',
      );
      final mut2 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-mix-02',
        storyId: 'story-mix-02',
      );
      final mut3 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-mix-03',
        storyId: 'story-mix-03',
      );

      await seedBookmarkWithMutation(mut1, admissionA);
      await seedBookmarkWithMutation(mut2, admissionA);
      await seedBookmarkWithMutation(mut3, admissionA);

      transport.customPushHandler = (ownerScope, mutations) async {
        return const PushMutationsBatchResponseWire(
          processedCount: 3,
          newServerRevision: '175',
          results: [
            MutationResultItemWire(
              mutationId: 'mut-mix-01',
              status: 'APPLIED',
              assignedRevision: '173',
            ),
            MutationResultItemWire(
              mutationId: 'mut-mix-02',
              status: 'CONFLICT_MERGED',
              assignedRevision: '174',
            ),
            MutationResultItemWire(
              mutationId: 'mut-mix-03',
              status: 'REJECTED_STALE',
              reason: 'Base revision compacted on server',
            ),
          ],
        );
      };

      final result = await reconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: admissionA,
      );

      expect(result.finalState, OfflineReconcilerState.idle);
      expect(result.mutationsPushed, 2); // mut1 (APPLIED) + mut2 (CONFLICT_MERGED)
      expect(result.mutationsQuarantined, 1); // mut3 (REJECTED_STALE)

      // Pending queue is empty
      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter, isEmpty);

      // Quarantine store has exactly 1 record
      final quarantined = await dal.getQuarantinedMutations(scopeA);
      expect(quarantined.length, 1);
      expect(quarantined.first.mutationId, 'mut-mix-03');
      expect(quarantined.first.rejectionStatus, 'REJECTED_STALE');
    });
  });

  // =========================================================================
  // GROUP 3: Atomic Settlement Failure Injection & Rollback
  // =========================================================================
  group('Mobile Stage 2A.1 — Group 3: Atomic Settlement Failure Injection & Rollback', () {
    final admissionA = testAccountAdmission(scopeA);

    test('13. Receipt validation failure during batch settlement rolls back 100% (zero partial delete)', () async {
      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
      );

      final mut1 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-fail-01',
        storyId: 'story-fail-01',
      );
      final mut2 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-fail-02',
        storyId: 'story-fail-02',
      );
      await seedBookmarkWithMutation(mut1, admissionA);
      await seedBookmarkWithMutation(mut2, admissionA);

      // Server returns invalid receipt for mut2 (unrecognized status)
      transport.customPushHandler = (ownerScope, mutations) async {
        return const PushMutationsBatchResponseWire(
          processedCount: 2,
          newServerRevision: '180',
          results: [
            MutationResultItemWire(
              mutationId: 'mut-fail-01',
              status: 'APPLIED',
              assignedRevision: '179',
            ),
            MutationResultItemWire(
              mutationId: 'mut-fail-02',
              status: 'MALFORMED_CORRUPTED_STATUS', // Protocol violation
              assignedRevision: '180',
            ),
          ],
        );
      };

      final result = await reconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: admissionA,
      );

      // Must fail closed and back off
      expect(result.finalState, OfflineReconcilerState.retryBackoff);
      expect(result.errorMessage, contains('Receipt validation failed'));

      // CRITICAL ASSERTION: mut-fail-01 was NOT deleted! Zero partial deletion occurred!
      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter.length, 2);
      final pendingIds = pendingAfter.map((m) => m.mutationId).toList();
      expect(pendingIds, containsAll(['mut-fail-01', 'mut-fail-02']));

      // Quarantine is empty
      final quarantined = await dal.getQuarantinedMutations(scopeA);
      expect(quarantined, isEmpty);
    });

    test('14. Injected SQLite exception midway before commit rolls back entire settlement', () async {
      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
        onBeforeSettlementCommitHook: (txn) async {
          throw Exception('SIMULATED_SQLITE_CRASH_BEFORE_COMMIT');
        },
      );

      final mut1 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-crash-01',
        storyId: 'story-crash-01',
      );
      final mut2 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-crash-02',
        storyId: 'story-crash-02',
      );
      await seedBookmarkWithMutation(mut1, admissionA);
      await seedBookmarkWithMutation(mut2, admissionA);

      transport.customPushHandler = (ownerScope, mutations) async {
        return const PushMutationsBatchResponseWire(
          processedCount: 2,
          newServerRevision: '190',
          results: [
            MutationResultItemWire(
              mutationId: 'mut-crash-01',
              status: 'APPLIED',
              assignedRevision: '189',
            ),
            MutationResultItemWire(
              mutationId: 'mut-crash-02',
              status: 'REJECTED_TOMBSTONE',
              reason: 'Tombstoned on server',
            ),
          ],
        );
      };

      final result = await reconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: admissionA,
      );

      expect(result.finalState, OfflineReconcilerState.retryBackoff);
      expect(result.errorMessage, contains('SIMULATED_SQLITE_CRASH_BEFORE_COMMIT'));

      // Both mutations MUST remain in pending queue untouched
      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter.length, 2);
      expect(pendingAfter.map((m) => m.mutationId).toList(), containsAll(['mut-crash-01', 'mut-crash-02']));

      // Nothing in quarantine
      final quarantined = await dal.getQuarantinedMutations(scopeA);
      expect(quarantined, isEmpty);
    });
  });

  // =========================================================================
  // GROUP 4: Mid-Flight Revocation & Account Switch Isolation
  // =========================================================================
  group('Mobile Stage 2A.1 — Group 4: Mid-Flight Revocation & Account Switch Tests', () {
    test('15. Logout / admission revocation after network await but BEFORE SQLite commit aborts cleanly', () async {
      final authoritySource = MutableSyncAuthoritySource.activeAccount('user-receipt-alpha');
      final dynamicAdmission = AccountWriteAdmission(
        authoritySource: authoritySource,
        expectedUserId: 'user-receipt-alpha',
        expectedGeneration: 1,
      );

      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
      );

      final mut = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-logout-01',
        storyId: 'story-logout-01',
      );
      await seedBookmarkWithMutation(mut, dynamicAdmission);

      // In pushMutationsBatch, right before response is returned, simulate user logging out:
      transport.customPushHandler = (ownerScope, mutations) async {
        // SIMULATE LOGOUT:
        authoritySource.isAuthenticated = false;
        authoritySource.authenticatedUserId = null;
        authoritySource.canMutateUserState = false;
        authoritySource.activeScope = null;
        authoritySource.transitionGeneration++;

        return const PushMutationsBatchResponseWire(
          processedCount: 1,
          newServerRevision: '200',
          results: [
            MutationResultItemWire(
              mutationId: 'mut-logout-01',
              status: 'APPLIED',
              assignedRevision: '200',
            ),
          ],
        );
      };

      final result = await reconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: dynamicAdmission,
      );

      // Must transition to authorityRevoked
      expect(result.finalState, OfflineReconcilerState.authorityRevoked);
      expect(result.errorMessage, contains('SYNC_ADMISSION_REJECTED'));

      // Mut-logout-01 is still in SQLite pending_mutations for scopeA
      // (because write was blocked by the mid-flight barrier check!)
      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter.length, 1);
      expect(pendingAfter.first.mutationId, 'mut-logout-01');

      // Zero cross-account contamination in scopeB
      final pendingB = await dal.getPendingMutations(scopeB);
      expect(pendingB, isEmpty);
    });

    test('16. Admission revocation inside SQLite transaction aborts commit via Barrier 4', () async {
      final authoritySource = MutableSyncAuthoritySource.activeAccount('user-receipt-alpha');
      final dynamicAdmission = AccountWriteAdmission(
        authoritySource: authoritySource,
        expectedUserId: 'user-receipt-alpha',
        expectedGeneration: 1,
      );

      final reconciler = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
        onBeforeSettlementCommitHook: (txn) async {
          // Revoke authority inside the transaction right before commit
          authoritySource.transitionGeneration = 999;
        },
      );

      final mut = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-rev-01',
        storyId: 'story-rev-01',
      );
      await seedBookmarkWithMutation(mut, dynamicAdmission);

      final result = await reconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: dynamicAdmission,
      );

      expect(result.finalState, OfflineReconcilerState.authorityRevoked);

      // Pending mutation is retained
      final pendingAfter = await dal.getPendingMutations(scopeA);
      expect(pendingAfter.length, 1);
      expect(pendingAfter.first.mutationId, 'mut-rev-01');
    });
  });

  // =========================================================================
  // GROUP 5: Crash & Reopen Durability with FIFO Preservation
  // =========================================================================
  group('Mobile Stage 2A.1 — Group 5: Crash & Reopen Durability Tests', () {
    final admissionA = testAccountAdmission(scopeA);

    test('17. Crash/reopen after aborted settlement preserves pending queue and FIFO sequence', () async {
      // Step 1: Enqueue 3 mutations
      final mut1 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-dur-01',
        storyId: 'story-dur-01',
      );
      final mut2 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-dur-02',
        storyId: 'story-dur-02',
      );
      final mut3 = createSampleMutation(
        ownerScope: scopeA,
        mutationId: 'mut-dur-03',
        storyId: 'story-dur-03',
      );
      await seedBookmarkWithMutation(mut1, admissionA);
      await seedBookmarkWithMutation(mut2, admissionA);
      await seedBookmarkWithMutation(mut3, admissionA);

      // Step 2: Attempt reconcile with failure injection on commit
      final reconcilerFail = OfflineSyncReconciler(
        dal: dal,
        transport: transport,
        ownerScope: scopeA,
        onBeforeSettlementCommitHook: (txn) async {
          throw Exception('FORCED_SIMULATED_ABORT');
        },
      );
      transport.customPushHandler = (ownerScope, mutations) async {
        return const PushMutationsBatchResponseWire(
          processedCount: 3,
          newServerRevision: '300',
          results: [
            MutationResultItemWire(mutationId: 'mut-dur-01', status: 'APPLIED', assignedRevision: '298'),
            MutationResultItemWire(mutationId: 'mut-dur-02', status: 'APPLIED', assignedRevision: '299'),
            MutationResultItemWire(mutationId: 'mut-dur-03', status: 'APPLIED', assignedRevision: '300'),
          ],
        );
      };

      await reconcilerFail.reconcileOnce(ownerScope: scopeA, admission: admissionA);

      // Step 3: Simulate hard process kill / database close
      await offlineDb.database.close();

      // Step 4: Reopen database
      final reopenedDb = OfflineDatabase();
      await reopenedDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );
      final newDal = SyncStorageDal(offlineDatabase: reopenedDb);

      // Verify all 3 mutations are intact with strict FIFO sequence numbers
      final reopenedPending = await newDal.getPendingMutations(scopeA);
      expect(reopenedPending.length, 3);
      expect(reopenedPending[0].mutationId, 'mut-dur-01');
      expect(reopenedPending[1].mutationId, 'mut-dur-02');
      expect(reopenedPending[2].mutationId, 'mut-dur-03');
      expect(reopenedPending[0].sequenceNo < reopenedPending[1].sequenceNo, isTrue);
      expect(reopenedPending[1].sequenceNo < reopenedPending[2].sequenceNo, isTrue);

      // Step 5: Normal reconcile succeeds on reopened database
      final successfulReconciler = OfflineSyncReconciler(
        dal: newDal,
        transport: transport,
        ownerScope: scopeA,
      );
      transport.customPushHandler = null; // Use default successful push

      final successResult = await successfulReconciler.reconcileOnce(
        ownerScope: scopeA,
        admission: admissionA,
      );

      expect(successResult.finalState, OfflineReconcilerState.idle);
      expect(successResult.mutationsPushed, 3);

      final finalPending = await newDal.getPendingMutations(scopeA);
      expect(finalPending, isEmpty);

      await reopenedDb.database.close();
    });
  });
}
