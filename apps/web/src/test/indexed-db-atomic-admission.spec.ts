import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  SyncDomain,
  SyncOperation,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  LocalSyncMeta,
  LocalPendingMutation,
  LocalQuarantinedMutation,
  InvalidDeltaPayloadError,
  PreDispatchAdmissionVerificationError,
  AdmitPreparedBatchPreDispatchOptions,
  CandidateMutationVerification,
} from '../lib/storage/indexed-db-client';

describe('Task A & C: IndexedDbClient.admitPreparedBatchPreDispatchAtomic', () => {
  let dbClient: IndexedDbClient;

  beforeEach(async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
    dbClient = new IndexedDbClient();
  });

  afterEach(() => {
    dbClient.close();
    vi.restoreAllMocks();
  });

  async function seedSyncMeta(
    scope: string,
    checkpoint: string = '0',
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
        authoritativeBaselineStatus: 'READY',
      } as LocalSyncMeta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function putPendingMutation(m: LocalPendingMutation): Promise<void> {
    const rawDb = await dbClient.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = rawDb.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
      tx.objectStore(STORE_PENDING_MUTATIONS).put(m);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // =========================================================================
  // 1. ATOMIC STALE QUARANTINE SUCCESS
  // =========================================================================
  it('moves stale pending mutation atomically to quarantine and preserves full payload and metadata', async () => {
    const scope = 'account:usr-stale-success';
    await seedSyncMeta(scope, '10', '50');

    const originalPayload = { storyId: 'story-1', title: 'Chapter Draft' };
    const mutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-stale-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-1',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10', // 10 < 50 -> stale
      payload: originalPayload,
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(mutation);

    const res = await dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
      candidates: [mutation],
    });

    expect(res.minActiveRevision).toBe('50');
    expect(res.eligibleMutations).toHaveLength(0);
    expect(res.quarantinedStaleMutations).toHaveLength(1);
    expect(res.quarantinedLegacyMutations).toHaveLength(0);

    // Verified: Removed from pending
    expect(await dbClient.getPendingMutation(scope, 'mut-stale-1')).toBeNull();

    // Verified: Quarantined with PENDING triage and preserved payload
    const q = await dbClient.getQuarantinedMutation(scope, 'mut-stale-1');
    expect(q).not.toBeNull();
    expect(q?.rejectionStatus).toBe('REJECTED_STALE');
    expect(q?.triageStatus).toBe('PENDING');
    expect(q?.payload).toEqual(originalPayload);
    expect(q?.originalCreatedAt).toBe('2026-11-10T08:00:00.000Z');
  });

  // =========================================================================
  // 2. TRANSACTION ABORT AND 100% ROLLBACK
  // =========================================================================
  it('rolls back 100% on transaction abort, preserving original pending mutation and leaving quarantine clean', async () => {
    const scope = 'account:usr-abort-rollback';
    await seedSyncMeta(scope, '10', '50');

    const originalPayload = { storyId: 'story-precious', note: 'Unsaved note' };
    const mutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-rb-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-rb',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10', // stale
      payload: originalPayload,
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(mutation);

    await expect(
      dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
        candidates: [mutation],
        _testHookBeforeComplete: (tx) => {
          tx.abort();
        },
      })
    ).rejects.toThrow();

    // Invariant: Pending mutation remains 100% intact with original payload and mutationId
    const pending = await dbClient.getPendingMutation(scope, 'mut-rb-1');
    expect(pending).not.toBeNull();
    expect(pending?.mutationId).toBe('mut-rb-1');
    expect(pending?.payload).toEqual(originalPayload);

    // Invariant: Quarantine store has NO record
    expect(await dbClient.getQuarantinedMutation(scope, 'mut-rb-1')).toBeNull();
  });

  // =========================================================================
  // 3. WATERMARK ADVANCEMENT BEFORE ADMISSION (TOCTOU PREVENTION)
  // =========================================================================
  it('prevents stale dispatch if watermark advances between batch preparation and admission', async () => {
    const scope = 'account:usr-watermark-advance';
    // Initially watermark was 10
    await seedSyncMeta(scope, '10', '10');

    const mutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-wm-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-wm',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '20', // Prepared when watermark was 10 (20 >= 10: eligible at prep time)
      payload: { storyId: 'story-wm' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(mutation);

    // Concurrently, before pre-dispatch admission, watermark advances to 50
    await seedSyncMeta(scope, '60', '50');

    const res = await dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
      candidates: [mutation],
    });

    // Stale mutation is caught and NEVER returned in eligibleMutations
    expect(res.eligibleMutations).toHaveLength(0);
    expect(res.quarantinedStaleMutations).toHaveLength(1);
    expect(res.quarantinedStaleMutations[0].mutationId).toBe('mut-wm-1');
  });

  // =========================================================================
  // 4. INVALID REVISION FORMAT
  // =========================================================================
  it('aborts transaction fail-closed when candidate or syncMeta has invalid revision format', async () => {
    const scope = 'account:usr-invalid-rev';
    await seedSyncMeta(scope, '10', '0');

    const badMutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-bad-rev',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-bad',
      operation: SyncOperation.UPSERT,
      baseServerRevision: 'not-a-number', // Malformed revision!
      payload: { storyId: 'bad' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(badMutation);

    await expect(
      dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
        candidates: [badMutation],
      })
    ).rejects.toThrow(InvalidDeltaPayloadError);

    // Malformed candidate was not quarantined or deleted
    expect(await dbClient.getPendingMutation(scope, 'mut-bad-rev')).not.toBeNull();
  });

  // =========================================================================
  // 5. OWNER-SCOPE MISMATCH
  // =========================================================================
  it('aborts and rejects when candidate ownerScope mismatches admission scope', async () => {
    const scopeA = 'account:usr-scope-mismatch-a';
    const scopeB = 'account:usr-scope-mismatch-b';
    await seedSyncMeta(scopeA, '10', '0');
    await seedSyncMeta(scopeB, '10', '0');

    const mutationA: LocalPendingMutation = {
      ownerScope: scopeA,
      mutationId: 'mut-scope-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-1',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10',
      payload: { storyId: 's1' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(mutationA);

    // Call with scopeB on candidate A
    await expect(
      dbClient.admitPreparedBatchPreDispatchAtomic(scopeB, {
        candidates: [mutationA], // mutationA has ownerScope: scopeA
      })
    ).rejects.toThrow(PreDispatchAdmissionVerificationError);

    // If candidate has no ownerScope field explicitly, storage lookup will detect mismatch
    const candidateWithoutScope: CandidateMutationVerification = {
      mutationId: 'mut-scope-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-1',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10',
      payload: { storyId: 's1' },
    };

    // Stored in scopeA, but requested for scopeB -> not found in scopeB storage
    await expect(
      dbClient.admitPreparedBatchPreDispatchAtomic(scopeB, {
        candidates: [candidateWithoutScope],
      })
    ).rejects.toThrow(PreDispatchAdmissionVerificationError);
  });

  // =========================================================================
  // 6. CANDIDATE CHANGED OR REMOVED AFTER PREPARATION
  // =========================================================================
  it('aborts transaction fail-closed if candidate was deleted concurrently from pending store', async () => {
    const scope = 'account:usr-removed-candidate';
    await seedSyncMeta(scope, '10', '0');

    const phantomCandidate: CandidateMutationVerification = {
      mutationId: 'mut-phantom-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-phantom',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10',
      payload: { storyId: 'phantom' },
    };

    // Candidate was NOT seeded in STORE_PENDING_MUTATIONS
    await expect(
      dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
        candidates: [phantomCandidate],
      })
    ).rejects.toThrow(PreDispatchAdmissionVerificationError);
  });

  // =========================================================================
  // 7. DUPLICATE MUTATION ID HANDLING
  // =========================================================================
  it('throws PreDispatchAdmissionVerificationError on duplicate mutationId in candidates', async () => {
    const scope = 'account:usr-duplicate-id';
    await seedSyncMeta(scope, '10', '0');

    const mutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-dup-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-dup',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10',
      payload: { storyId: 'dup' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(mutation);

    await expect(
      dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
        candidates: [mutation, { ...mutation }], // Duplicate!
      })
    ).rejects.toThrow(PreDispatchAdmissionVerificationError);
  });

  // =========================================================================
  // 8. IMMUTABLE CANONICAL PAYLOAD VERIFICATION
  // =========================================================================
  it('aborts transaction if live pending payload differs from prepared candidate payload', async () => {
    const scope = 'account:usr-payload-tamper';
    await seedSyncMeta(scope, '10', '0');

    const liveMutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-payload-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-tamper',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10',
      payload: { storyId: 'tamper', version: 1 },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(liveMutation);

    // Candidate payload differs
    const candidateTampered: CandidateMutationVerification = {
      ...liveMutation,
      payload: { storyId: 'tamper', version: 2 }, // Tampered!
    };

    await expect(
      dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
        candidates: [candidateTampered],
      })
    ).rejects.toThrow(PreDispatchAdmissionVerificationError);

    // Live DB record was not mutated
    const inDb = await dbClient.getPendingMutation(scope, 'mut-payload-1');
    expect(inDb?.payload).toEqual({ storyId: 'tamper', version: 1 });
  });

  // =========================================================================
  // 9. LEGACY HISTORY 'all' QUARANTINE
  // =========================================================================
  it('quarantines legacy HISTORY entityId="all" without rewriting entityId on the wire', async () => {
    const scope = 'account:usr-legacy-all';
    await seedSyncMeta(scope, '10', '0');

    const legacyMutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-legacy-all-1',
      clientId: 'client-legacy',
      domain: SyncDomain.HISTORY,
      entityId: 'all', // Legacy non-canonical entityId
      operation: SyncOperation.DELETE,
      baseServerRevision: '10',
      payload: { clearTimestamp: '2026-11-09T00:00:00.000Z' },
      createdAt: '2026-11-09T00:00:00.000Z',
    };
    await putPendingMutation(legacyMutation);

    const res = await dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
      candidates: [legacyMutation],
    });

    expect(res.eligibleMutations).toHaveLength(0);
    expect(res.quarantinedLegacyMutations).toHaveLength(1);
    expect(res.quarantinedStaleMutations).toHaveLength(0);

    // Pending deleted
    expect(await dbClient.getPendingMutation(scope, 'mut-legacy-all-1')).toBeNull();

    // Quarantine preserves 'all' without silent morphing
    const q = await dbClient.getQuarantinedMutation(scope, 'mut-legacy-all-1');
    expect(q?.rejectionReason).toBe('LEGACY_ENTITY_ID_REWRITE_PROHIBITED');
    expect(q?.rejectionStatus).toBe('MANUAL');
    expect(q?.entityId).toBe('all');
    expect(q?.payload).toEqual({ clearTimestamp: '2026-11-09T00:00:00.000Z' });
  });

  // =========================================================================
  // 10. SAME MUTATION ACROSS DIFFERENT ACCOUNT SCOPES
  // =========================================================================
  it('strictly isolates mutations with identical IDs across different account scopes', async () => {
    const scopeA = 'account:usr-iso-test-a';
    const scopeB = 'account:usr-iso-test-b';
    await seedSyncMeta(scopeA, '10', '50'); // Scope A watermark is 50
    await seedSyncMeta(scopeB, '10', '0');  // Scope B watermark is 0

    const mutationA: LocalPendingMutation = {
      ownerScope: scopeA,
      mutationId: 'mut-shared-id',
      clientId: 'client-a',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-a',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10', // Stale in A (10 < 50)
      payload: { user: 'Alice' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    const mutationB: LocalPendingMutation = {
      ownerScope: scopeB,
      mutationId: 'mut-shared-id',
      clientId: 'client-b',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-b',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10', // Eligible in B (10 >= 0)
      payload: { user: 'Bob' },
      createdAt: '2026-11-10T08:01:00.000Z',
    };

    await putPendingMutation(mutationA);
    await putPendingMutation(mutationB);

    // Execute admission on Scope A
    const resA = await dbClient.admitPreparedBatchPreDispatchAtomic(scopeA, {
      candidates: [mutationA],
    });
    expect(resA.quarantinedStaleMutations).toHaveLength(1);
    expect(resA.eligibleMutations).toHaveLength(0);

    // Verify Scope B was NOT touched at all
    const pendingB = await dbClient.getPendingMutation(scopeB, 'mut-shared-id');
    expect(pendingB).not.toBeNull();
    expect(pendingB?.payload).toEqual({ user: 'Bob' });
    expect(await dbClient.getQuarantinedMutation(scopeB, 'mut-shared-id')).toBeNull();
  });

  // =========================================================================
  // 11. FAILURE INJECTION AT WRITE BOUNDARIES
  // =========================================================================
  it('rolls back completely when error is thrown from test hook right before commit', async () => {
    const scope = 'account:usr-failure-hook';
    await seedSyncMeta(scope, '10', '50');

    const mutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-fail-hook',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-fh',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10',
      payload: { storyId: 'hook' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(mutation);

    await expect(
      dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
        candidates: [mutation],
        _testHookBeforeComplete: () => {
          throw new Error('SIMULATED_WRITE_CRASH');
        },
      })
    ).rejects.toThrow('SIMULATED_WRITE_CRASH');

    // Rollback guaranteed
    expect(await dbClient.getPendingMutation(scope, 'mut-fail-hook')).not.toBeNull();
    expect(await dbClient.getQuarantinedMutation(scope, 'mut-fail-hook')).toBeNull();
  });

  // =========================================================================
  // 12. 64-BIT BIGINT REVISIONS EXCEEDING Number.MAX_SAFE_INTEGER
  // =========================================================================
  it('evaluates 64-bit BigInt revisions exceeding Number.MAX_SAFE_INTEGER without precision loss', async () => {
    const scope = 'account:usr-bigint-bounds';
    const watermarkStr = '9007199254740996'; // MAX_SAFE_INTEGER + 5
    await seedSyncMeta(scope, '9007199254740000', watermarkStr);

    const staleHuge: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-stale-huge',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-huge-stale',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '9007199254740995', // 9007199254740995 < 9007199254740996 -> STALE
      payload: { note: 'Stale by 1 unit beyond MAX_SAFE_INTEGER' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };

    const eligibleHuge: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-eligible-huge',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-huge-ok',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '9007199254740997', // 9007199254740997 > 9007199254740996 -> ELIGIBLE
      payload: { note: 'Eligible huge' },
      createdAt: '2026-11-10T08:01:00.000Z',
    };

    await putPendingMutation(staleHuge);
    await putPendingMutation(eligibleHuge);

    const res = await dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
      candidates: [staleHuge, eligibleHuge],
    });

    expect(res.quarantinedStaleMutations).toHaveLength(1);
    expect(res.quarantinedStaleMutations[0].mutationId).toBe('mut-stale-huge');
    expect(res.eligibleMutations).toHaveLength(1);
    expect(res.eligibleMutations[0].mutationId).toBe('mut-eligible-huge');
  });

  // =========================================================================
  // 13. CRASH / REOPEN DURABILITY
  // =========================================================================
  it('persists committed admission state across database close and reopen', async () => {
    const scope = 'account:usr-durability';
    await seedSyncMeta(scope, '10', '50');

    const mStale: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-durable-stale',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-ds',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10',
      payload: { data: 'persist' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    const mEligible: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-durable-ok',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-do',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '55',
      payload: { data: 'persist-ok' },
      createdAt: '2026-11-10T08:01:00.000Z',
    };

    await putPendingMutation(mStale);
    await putPendingMutation(mEligible);

    await dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
      candidates: [mStale, mEligible],
    });

    // Simulate browser crash or reload: close connection
    dbClient.close();

    // Reopen via fresh instance
    const reopenedDb = new IndexedDbClient();
    try {
      expect(await reopenedDb.getPendingMutation(scope, 'mut-durable-stale')).toBeNull();
      const q = await reopenedDb.getQuarantinedMutation(scope, 'mut-durable-stale');
      expect(q).not.toBeNull();
      expect(q?.rejectionStatus).toBe('REJECTED_STALE');

      const pOk = await reopenedDb.getPendingMutation(scope, 'mut-durable-ok');
      expect(pOk).not.toBeNull();
      expect(pOk?.baseServerRevision).toBe('55');
    } finally {
      reopenedDb.close();
    }
  });

  // =========================================================================
  // 14. COMPATIBILITY WITH GC RETENTION FLOOR AND TERMINAL RECEIPTS
  // =========================================================================
  it('quarantined mutation from admission acts as valid GC retention floor pin', async () => {
    const scope = 'account:usr-gc-compat';
    await seedSyncMeta(scope, '10', '50');

    // Create tombstone at revision 40
    await dbClient.putAuthoritativeTombstone({
      ownerScope: scope,
      domain: SyncDomain.BOOKMARK,
      entityKey: 'bm-gc-pinned',
      deletedAtRevision: '40',
      updatedAt: Date.now(),
    });

    // Stale mutation at revision 30 is quarantined
    const mutation: LocalPendingMutation = {
      ownerScope: scope,
      mutationId: 'mut-gc-pin-1',
      clientId: 'client-1',
      domain: SyncDomain.BOOKMARK,
      entityId: 'bm-gc-pinned',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '30',
      payload: { storyId: 'pinned' },
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    await putPendingMutation(mutation);

    await dbClient.admitPreparedBatchPreDispatchAtomic(scope, {
      candidates: [mutation],
    });

    const quarantined = await dbClient.getQuarantinedMutation(scope, 'mut-gc-pin-1');
    expect(quarantined).not.toBeNull();
    expect(quarantined?.triageStatus).toBe('PENDING');

    // Run gcAuthoritativeTombstones: The tombstone at rev 40 is protected because baseServerRevision is 30 (< 40)
    // and PENDING triage must NOT be excluded from retention floor!
    const gcResult = await dbClient.gcAuthoritativeTombstones(scope);
    expect(gcResult.deletedCount).toBe(0);
    expect(gcResult.retainedCount).toBe(1);

    // Verify tombstone survived GC
    const tStore = await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-gc-pinned');
    expect(tStore).not.toBeNull();
  });
});
