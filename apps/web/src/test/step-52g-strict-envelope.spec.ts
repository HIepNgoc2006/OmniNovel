import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  SyncDomain,
  SyncOperation,
  MutationResultItem,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  LocalPendingMutation,
} from '../lib/storage/indexed-db-client';
import {
  MutationQueue,
  createStaticIdentityProvider,
} from '../lib/sync/mutation-queue';
import { TabLeaderElection } from '../lib/sync/tab-leader-election';
import {
  InMemoryLockManager,
  MockSyncTransportServer,
  MockStep52dReconciler,
  StrictStep52gReconciler,
  validateBatchReceiptsStrictFailClosed,
  ReceiptValidationException,
  isValidCanonicalRevisionString,
  MAX_POSTGRES_BIGINT,
} from './harness/mock-sync-transport-harness';
import {
  CanonicalWireMutationBatchResponse,
  WireMutationBatchResponse,
} from './fixtures/step-52d-contract-fixtures';

describe('Web Step 5.2g Strict Wire Response Envelope & Receipt Policy Remediation', () => {
  let dbClient: IndexedDbClient;
  let transportServer: MockSyncTransportServer;
  let lockManager: InMemoryLockManager;

  beforeEach(async () => {
    dbClient = new IndexedDbClient();
    lockManager = new InMemoryLockManager();
    transportServer = new MockSyncTransportServer();
  });

  afterEach(async () => {
    await dbClient.close();
  });

  async function seedReadySyncMeta(
    scope: string,
    checkpoint: string,
    minActive: string = '0'
  ): Promise<void> {
    const rawDb = await dbClient.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = rawDb.transaction(STORE_SYNC_META, 'readwrite');
      tx.objectStore(STORE_SYNC_META).put({
        ownerScope: scope,
        lastSyncedServerRevision: checkpoint,
        minActiveRevision: minActive,
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'PULL_COMPLETED',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // =========================================================================
  // TASK A: Strict Envelope Integrity (Mandatory Canonical Fields & Fail-Closed)
  // =========================================================================
  describe('Task A: Strict Envelope Integrity', () => {
    it('1.1 rejects null, undefined, or non-object wire response fail-closed', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-1' } as any,
      ];

      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, null as any)
      ).toThrow(ReceiptValidationException);

      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, undefined as any)
      ).toThrow(ReceiptValidationException);

      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, 'not-an-object' as any)
      ).toThrow(/INVALID_ENVELOPE/);
    });

    it('1.2 rejects missing or non-array results field', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-1' } as any,
      ];

      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '11',
        } as any)
      ).toThrow(/MISSING_ENVELOPE_FIELD: results array/);

      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '11',
          results: 'not-array' as any,
        } as any)
      ).toThrow(/MISSING_ENVELOPE_FIELD: results array/);
    });

    it('1.3 rejects when receipt count does not strictly match dispatched count', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-1' } as any,
        { mutationId: 'mut-2' } as any,
      ];

      // Omitted receipt (sent 2, received 1)
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 2,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        })
      ).toThrow(/RECEIPT_COUNT_MISMATCH: Sent 2 mutations, but server returned 1 receipts/);

      // Superfluous receipts (sent 2, received 3)
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 2,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
            { mutationId: 'mut-2', status: 'APPLIED', assignedRevision: '12' },
            { mutationId: 'mut-3', status: 'APPLIED', assignedRevision: '13' },
          ],
        })
      ).toThrow(/RECEIPT_COUNT_MISMATCH: Sent 2 mutations, but server returned 3 receipts/);
    });

    it('1.4 rejects missing, null, or invalid processedCount field', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-1' } as any,
      ];

      // Missing processedCount
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        } as any)
      ).toThrow(/MISSING_ENVELOPE_FIELD: processedCount/);

      // Null processedCount
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: null as any,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        } as any)
      ).toThrow(/MISSING_ENVELOPE_FIELD: processedCount/);

      // Negative processedCount
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: -1,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        })
      ).toThrow(/INVALID_PROCESSED_COUNT/);

      // Non-integer (float) processedCount
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1.5,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        })
      ).toThrow(/INVALID_PROCESSED_COUNT/);

      // Processed count mismatch with sent batch
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 0,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        })
      ).toThrow(/PROCESSED_COUNT_MISMATCH: Sent 1 mutations, but server processedCount is 0/);
    });

    it('1.5 rejects missing, null, or non-canonical newServerRevision field', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-1' } as any,
      ];

      // Missing newServerRevision
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        } as any)
      ).toThrow(/MISSING_ENVELOPE_FIELD: newServerRevision/);

      // Null newServerRevision
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: null as any,
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        } as any)
      ).toThrow(/MISSING_ENVELOPE_FIELD: newServerRevision/);

      // Non-canonical newServerRevision (leading zero)
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '011',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        })
      ).toThrow(/INVALID_SERVER_REVISION/);

      // Non-canonical newServerRevision (negative)
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '-11',
          results: [
            { mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' },
          ],
        })
      ).toThrow(/INVALID_SERVER_REVISION/);
    });

    it('1.6 enforces zero settlement and full rollback in IndexedDB when envelope is corrupt', async () => {
      const scope = 'account:usr-step52g-zerosettle';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-envelope-fail',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-env-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's1' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new StrictStep52gReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server returns invalid envelope (processedCount missing)
      transportServer.queueBatchResponse({
        newServerRevision: '11',
        results: [
          { mutationId: 'mut-envelope-fail', status: 'APPLIED', assignedRevision: '11' },
        ],
      } as any);

      const res = await reconciler.pushPendingMutations();

      // Zero mutations pushed or applied
      expect(res.pushedCount).toBe(0);
      expect(res.appliedCount).toBe(0);
      expect(res.rejectedCount).toBe(0);
      expect(res.transientRetryCount).toBe(1);
      expect(res.validationError).toBeInstanceOf(ReceiptValidationException);
      expect(res.validationError?.message).toContain('MISSING_ENVELOPE_FIELD: processedCount');

      // Pending mutation remains safely in IDB
      const pending = await dbClient.getPendingMutation(scope, 'mut-envelope-fail');
      expect(pending).not.toBeNull();
      expect(pending?.mutationId).toBe('mut-envelope-fail');

      // In-flight lock is released
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      tab.destroy();
    });
  });

  // =========================================================================
  // TASK B: Receipt Settlement Policy (Whole-Batch Fail-Closed vs Tolerant)
  // =========================================================================
  describe('Task B: Receipt Settlement Policy & Cross-Client Parity', () => {
    it('2.1 whole-batch fail-closed rejects entire batch on any corrupted receipt under strict policy', async () => {
      const scope = 'account:usr-step52g-strict-batch';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      // Enqueue 3 mutations
      const mutations = ['mut-strict-1', 'mut-strict-2', 'mut-strict-3'];
      for (let i = 0; i < mutations.length; i++) {
        await queue.enqueue({
          ownerScope: scope,
          mutationId: mutations[i],
          clientId: 'client-1',
          domain: SyncDomain.PROGRESS,
          entityId: `progress-${i + 1}`,
          operation: SyncOperation.UPSERT,
          baseServerRevision: '10',
          payload: { chapterId: `chap-${i + 1}` },
          createdAt: '2026-11-10T08:00:00.000Z',
          retryCount: 0,
        });
      }

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new StrictStep52gReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server returns 2 valid receipts and 1 corrupt receipt (unrecognized status)
      const canonicalResponse: CanonicalWireMutationBatchResponse = {
        processedCount: 3,
        newServerRevision: '13',
        results: [
          { mutationId: 'mut-strict-1', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-strict-2', status: 'CORRUPT_UNKNOWN_STATUS' as any, assignedRevision: '12' },
          { mutationId: 'mut-strict-3', status: 'APPLIED', assignedRevision: '13' },
        ],
      };
      transportServer.queueBatchResponse(canonicalResponse);

      const res = await reconciler.pushPendingMutations();

      // Strict fail-closed: ALL 3 mutations fail settlement!
      expect(res.pushedCount).toBe(0);
      expect(res.appliedCount).toBe(0);
      expect(res.deduplicatedCount).toBe(0);
      expect(res.conflictMergedCount).toBe(0);
      expect(res.rejectedCount).toBe(0);
      expect(res.transientRetryCount).toBe(3);
      expect(res.validationError).toBeInstanceOf(ReceiptValidationException);
      expect(res.validationError?.message).toContain('UNRECOGNIZED_RECEIPT_STATUS');

      // Crucial: ALL 3 mutations remain in pending store untouched
      for (const mId of mutations) {
        const item = await dbClient.getPendingMutation(scope, mId);
        expect(item).not.toBeNull();
      }

      // In-flight batch ownership is released so retry can proceed
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      tab.destroy();
    });

    it('2.2 comparative test: tolerant policy settles valid receipts and keeps only unvalidated mutation in pending', async () => {
      const scope = 'account:usr-step52g-tolerant-batch';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      const mutations = ['mut-tol-1', 'mut-tol-2', 'mut-tol-3'];
      for (let i = 0; i < mutations.length; i++) {
        await queue.enqueue({
          ownerScope: scope,
          mutationId: mutations[i],
          clientId: 'client-1',
          domain: SyncDomain.PROGRESS,
          entityId: `progress-${i + 1}`,
          operation: SyncOperation.UPSERT,
          baseServerRevision: '10',
          payload: { chapterId: `chap-${i + 1}` },
          createdAt: '2026-11-10T08:00:00.000Z',
          retryCount: 0,
        });
      }

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      // Tolerant reconciler (default policy)
      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
        policy: 'tolerant',
      });

      // Same server response with 1 corrupted receipt
      const canonicalResponse: CanonicalWireMutationBatchResponse = {
        processedCount: 3,
        newServerRevision: '13',
        results: [
          { mutationId: 'mut-tol-1', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-tol-2', status: 'CORRUPT_UNKNOWN_STATUS' as any, assignedRevision: '12' },
          { mutationId: 'mut-tol-3', status: 'APPLIED', assignedRevision: '13' },
        ],
      };
      transportServer.queueBatchResponse(canonicalResponse);

      const res = await reconciler.pushPendingMutations();

      // Tolerant partial settlement: settles the 2 valid mutations
      expect(res.pushedCount).toBe(3);
      expect(res.appliedCount).toBe(2);
      expect(res.rejectedCount).toBe(0);
      expect(res.transientRetryCount).toBe(1); // mut-tol-2 kept for retry

      // mut-tol-1 and mut-tol-3 settled and deleted from pending
      expect(await dbClient.getPendingMutation(scope, 'mut-tol-1')).toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-tol-3')).toBeNull();

      // mut-tol-2 is preserved in pending store
      expect(await dbClient.getPendingMutation(scope, 'mut-tol-2')).not.toBeNull();

      tab.destroy();
    });

    it('2.3 strict policy rejects entire batch on unexpected mutation ID (phantom receipt)', async () => {
      const scope = 'account:usr-step52g-strict-phantom';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-valid-sent',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's1' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new StrictStep52gReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server returns unexpected phantom ID
      transportServer.queueBatchResponse({
        processedCount: 1,
        newServerRevision: '11',
        results: [
          { mutationId: 'mut-phantom-alien', status: 'APPLIED', assignedRevision: '11' },
        ],
      });

      const res = await reconciler.pushPendingMutations();

      expect(res.pushedCount).toBe(0);
      expect(res.appliedCount).toBe(0);
      expect(res.validationError).toBeInstanceOf(ReceiptValidationException);
      expect(res.validationError?.message).toContain('UNEXPECTED_MUTATION_ID');

      // Original sent mutation is still safe in pending
      expect(await dbClient.getPendingMutation(scope, 'mut-valid-sent')).not.toBeNull();
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      tab.destroy();
    });

    it('2.4 strict policy rejects entire batch on duplicate receipts in wire response', async () => {
      const scope = 'account:usr-step52g-strict-dup-receipt';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-dup-target-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's1' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });
      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-dup-target-2',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-2',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's2' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new StrictStep52gReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server returns duplicate receipt for mut-dup-target-1 (and omitted mut-dup-target-2)
      transportServer.queueBatchResponse({
        processedCount: 2,
        newServerRevision: '12',
        results: [
          { mutationId: 'mut-dup-target-1', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-dup-target-1', status: 'APPLIED', assignedRevision: '12' },
        ],
      });

      const res = await reconciler.pushPendingMutations();

      expect(res.pushedCount).toBe(0);
      expect(res.appliedCount).toBe(0);
      expect(res.validationError).toBeInstanceOf(ReceiptValidationException);
      expect(res.validationError?.message).toContain('DUPLICATE_RECEIPT');

      // Both mutations remain safe in pending
      expect(await dbClient.getPendingMutation(scope, 'mut-dup-target-1')).not.toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-dup-target-2')).not.toBeNull();

      tab.destroy();
    });
  });

  // =========================================================================
  // TASK C: Telemetry Differentiation
  // =========================================================================
  describe('Task C: Telemetry Differentiation', () => {
    it('3.1 counts CONFLICT_MERGED in conflictMergedCount and excludes it from rejectedCount', async () => {
      const scope = 'account:usr-step52g-conflict-telemetry';
      await seedReadySyncMeta(scope, '10', '0');

      let deltaPullTriggered = false;
      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
        onAuthoritativeDeltaPullRequired: async () => {
          deltaPullTriggered = true;
        },
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-conflict-telemetry',
        clientId: 'client-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'progress-conflict',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { chapterId: 'c1', progress: 50 },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new StrictStep52gReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      transportServer.queueBatchResponse({
        processedCount: 1,
        newServerRevision: '12',
        results: [
          {
            mutationId: 'mut-conflict-telemetry',
            status: 'CONFLICT_MERGED',
            assignedRevision: '12',
            message: 'Progress conflict resolved with server winner',
          },
        ],
      });

      const res = await reconciler.pushPendingMutations();

      // Task C: Invariant Verification
      expect(res.conflictMergedCount).toBe(1);
      expect(res.rejectedCount).toBe(0); // MUST NOT be classified as terminal rejection!
      expect(res.appliedCount).toBe(0);
      expect(res.deduplicatedCount).toBe(0);
      expect(res.transientRetryCount).toBe(0);
      expect(res.quarantinedCount).toBe(0);

      // Pending mutation is settled
      expect(await dbClient.getPendingMutation(scope, 'mut-conflict-telemetry')).toBeNull();
      expect(deltaPullTriggered).toBe(true);

      tab.destroy();
    });

    it('3.2 distinguishes terminal rejections and captures total quarantinedCount across pre-dispatch and wire receipts', async () => {
      const scope = 'account:usr-step52g-rejections-telemetry';
      // Initial state: watermark is at 0
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      // 1. Stale mutation pre-dispatch (baseServerRevision 10) -> will be caught by atomic admission when watermark advances to 15
      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-pre-stale',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-pre',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's1' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      // 2. Eligible mutation (baseServerRevision 16) -> will be rejected as tombstone by wire receipt
      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-wire-tombstone',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-tomb',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '16',
        payload: { storyId: 's2' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      // 3. Eligible mutation (baseServerRevision 16) -> will be rejected as stale by wire receipt
      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-wire-stale',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-wire-stale',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '16',
        payload: { storyId: 's3' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new StrictStep52gReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Wire response for the 2 dispatched mutations
      transportServer.queueBatchResponse({
        processedCount: 2,
        newServerRevision: '21',
        results: [
          { mutationId: 'mut-wire-tombstone', status: 'REJECTED_TOMBSTONE', assignedRevision: null },
          { mutationId: 'mut-wire-stale', status: 'REJECTED_STALE', assignedRevision: null, reason: 'BASE_REVISION_EXPIRED' },
        ],
      });

      const res = await reconciler.pushPendingMutations({
        _testHookAfterPrepareBatch: async () => {
          // Watermark advances from 0 to 15 between batch prep and atomic admission
          await seedReadySyncMeta(scope, '20', '15');
        },
      });

      // Dispatched count is 2 (mut-pre-stale was filtered pre-dispatch)
      expect(res.dispatchedCount).toBe(2);
      expect(res.appliedCount).toBe(0);
      expect(res.deduplicatedCount).toBe(0);
      expect(res.conflictMergedCount).toBe(0);

      // Terminal rejections = 2 (tombstone + wire stale)
      expect(res.rejectedCount).toBe(2);

      // Quarantined count = 1 pre-dispatch + 1 wire receipt = 2 total
      expect(res.quarantinedStaleCount).toBe(1); // pre-dispatch
      expect(res.quarantinedCount).toBe(2); // total quarantined

      // Verify IDB state
      expect(await dbClient.getPendingMutation(scope, 'mut-pre-stale')).toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-wire-tombstone')).toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-wire-stale')).toBeNull();

      expect(await dbClient.getQuarantinedMutation(scope, 'mut-pre-stale')).not.toBeNull();
      expect(await dbClient.getQuarantinedMutation(scope, 'mut-wire-stale')).not.toBeNull();
      expect(await dbClient.getQuarantinedMutation(scope, 'mut-wire-tombstone')).toBeNull(); // tombstone is evicted, not quarantined

      tab.destroy();
    });
  });

  // =========================================================================
  // TASK D: Revision & Identity Invariants
  // =========================================================================
  describe('Task D: Revision & Identity Invariants', () => {
    it('4.1 canonical 64-bit signed BIGINT validation adheres to protocol range [0, 2^63 - 1]', () => {
      // Valid canonical revisions
      expect(isValidCanonicalRevisionString('0')).toBe(true);
      expect(isValidCanonicalRevisionString('1')).toBe(true);
      expect(isValidCanonicalRevisionString('100')).toBe(true);
      expect(isValidCanonicalRevisionString(MAX_POSTGRES_BIGINT.toString())).toBe(true); // 9223372036854775807

      // Invalid canonical revisions
      expect(isValidCanonicalRevisionString('01')).toBe(false); // leading zero rejected
      expect(isValidCanonicalRevisionString('000')).toBe(false);
      expect(isValidCanonicalRevisionString('-1')).toBe(false); // negative rejected
      expect(isValidCanonicalRevisionString('1.5')).toBe(false); // float rejected
      expect(isValidCanonicalRevisionString('abc')).toBe(false); // non-numeric rejected
      expect(isValidCanonicalRevisionString('')).toBe(false); // empty rejected
      expect(isValidCanonicalRevisionString(' ')).toBe(false); // whitespace rejected
      expect(isValidCanonicalRevisionString(null)).toBe(false);
      expect(isValidCanonicalRevisionString(undefined)).toBe(false);
      expect(isValidCanonicalRevisionString(100)).toBe(false); // number type rejected (must be string)

      // Overflow (> 2^63 - 1)
      const overflow = (MAX_POSTGRES_BIGINT + 1n).toString();
      expect(isValidCanonicalRevisionString(overflow)).toBe(false);
    });

    it('4.2 rejects untrimmed mutationId in receipt fail-closed without silent trimming', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-untrimmed-id' } as any,
      ];

      // Leading space in receipt mutationId
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '11',
          results: [
            { mutationId: ' mut-untrimmed-id', status: 'APPLIED', assignedRevision: '11' },
          ],
        })
      ).toThrow(/UNTRIMMED_MUTATION_ID/);

      // Trailing space in receipt mutationId
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-untrimmed-id ', status: 'APPLIED', assignedRevision: '11' },
          ],
        })
      ).toThrow(/UNTRIMMED_MUTATION_ID/);
    });

    it('4.3 rejects lowercase or untrimmed status without silent normalization', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-status-case' } as any,
      ];

      // Lowercase status
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-status-case', status: 'applied' as any, assignedRevision: '11' },
          ],
        })
      ).toThrow(/UNRECOGNIZED_RECEIPT_STATUS: Status "applied"/);

      // Untrimmed status
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '11',
          results: [
            { mutationId: 'mut-status-case', status: 'APPLIED ' as any, assignedRevision: '11' },
          ],
        })
      ).toThrow(/UNRECOGNIZED_RECEIPT_STATUS/);
    });

    it('4.4 causal ceiling invariant: rejects when newServerRevision < assignedRevision for APPLIED', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-causal-ceiling', baseServerRevision: '10' } as any,
      ];

      // Server returns assignedRevision 15 but newServerRevision is only 14!
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '14',
          results: [
            { mutationId: 'mut-causal-ceiling', status: 'APPLIED', assignedRevision: '15' },
          ],
        })
      ).toThrow(/SERVER_REVISION_BEHIND_ASSIGNED: Status "APPLIED" for mutationId "mut-causal-ceiling" assignedRevision \(15\) > newServerRevision \(14\)/);
    });

    it('4.5 causal monotonicity invariant: rejects when assignedRevision < baseServerRevision for APPLIED', () => {
      const dispatched: LocalPendingMutation[] = [
        { mutationId: 'mut-causal-mono', baseServerRevision: '15' } as any,
      ];

      // Server returns assignedRevision 12 when base was already 15!
      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatched, {
          processedCount: 1,
          newServerRevision: '20',
          results: [
            { mutationId: 'mut-causal-mono', status: 'APPLIED', assignedRevision: '12' },
          ],
        })
      ).toThrow(/ASSIGNED_REVISION_BEHIND_BASE: Status "APPLIED" for mutationId "mut-causal-mono" assignedRevision \(12\) < baseServerRevision \(15\)/);
    });

    it('4.6 rejects duplicate mutationId within the sent batch before dispatch', () => {
      const dispatchedWithDuplicates: LocalPendingMutation[] = [
        { mutationId: 'mut-sent-dup', baseServerRevision: '10' } as any,
        { mutationId: 'mut-sent-dup', baseServerRevision: '10' } as any,
      ];

      expect(() =>
        validateBatchReceiptsStrictFailClosed(dispatchedWithDuplicates, {
          processedCount: 2,
          newServerRevision: '12',
          results: [
            { mutationId: 'mut-sent-dup', status: 'APPLIED', assignedRevision: '11' },
            { mutationId: 'mut-sent-dup', status: 'APPLIED', assignedRevision: '12' },
          ],
        })
      ).toThrow(/DUPLICATE_SENT_MUTATION: Sent batch contains duplicate mutationId "mut-sent-dup"/);
    });
  });
});
