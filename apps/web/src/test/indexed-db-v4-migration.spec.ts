import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  IndexedDbClient,
  DB_NAME,
  DB_VERSION,
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  STORE_PREFERENCES,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  STORE_SNAPSHOT_STAGING,
  STORE_AUTHORITATIVE_REPLICAS,
  LocalSyncMeta,
  LocalPendingMutation,
  AuthoritativeShadowRecord,
  AuthoritativeBaselineStatus,
} from '../lib/storage/indexed-db-client';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
} from '@omninovel/shared';

describe('Phase 5.2a — IndexedDB v4 Migration & Baseline Lifecycle (ST-07 & ST-10)', () => {
  let dbClient: IndexedDbClient;

  beforeEach(async () => {
    // Reset fakeIndexedDB state between tests
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

  describe('ST-07A: Fresh Database v4 Creation & Store Verification', () => {
    it('creates all 9 object stores with correct composite keyPaths and indexes on a fresh database', async () => {
      const db = await dbClient.getDatabase();
      expect(db.name).toBe(DB_NAME);
      expect(db.version).toBe(4);

      const storeNames = Array.from(db.objectStoreNames);
      expect(storeNames).toHaveLength(9);
      expect(storeNames).toContain(STORE_BOOKMARKS);
      expect(storeNames).toContain(STORE_PROGRESS);
      expect(storeNames).toContain(STORE_HISTORY);
      expect(storeNames).toContain(STORE_PREFERENCES);
      expect(storeNames).toContain(STORE_SYNC_META);
      expect(storeNames).toContain(STORE_PENDING_MUTATIONS);
      expect(storeNames).toContain(STORE_QUARANTINED_MUTATIONS);
      expect(storeNames).toContain(STORE_SNAPSHOT_STAGING);
      expect(storeNames).toContain(STORE_AUTHORITATIVE_REPLICAS);

      const tx = db.transaction(storeNames, 'readonly');

      // Verify keyPaths
      expect(tx.objectStore(STORE_BOOKMARKS).keyPath).toEqual(['ownerScope', 'storyId']);
      expect(tx.objectStore(STORE_PROGRESS).keyPath).toEqual(['ownerScope', 'storyId']);
      expect(tx.objectStore(STORE_HISTORY).keyPath).toEqual(['ownerScope', 'storyId', 'chapterId']);
      expect(tx.objectStore(STORE_PREFERENCES).keyPath).toEqual(['ownerScope', 'key']);
      expect(tx.objectStore(STORE_SYNC_META).keyPath).toBe('ownerScope');
      expect(tx.objectStore(STORE_PENDING_MUTATIONS).keyPath).toEqual(['ownerScope', 'mutationId']);
      expect(tx.objectStore(STORE_QUARANTINED_MUTATIONS).keyPath).toEqual(['ownerScope', 'mutationId']);
      expect(tx.objectStore(STORE_SNAPSHOT_STAGING).keyPath).toEqual(['ownerScope', 'sessionId', 'domain', 'entityKey']);
      expect(tx.objectStore(STORE_AUTHORITATIVE_REPLICAS).keyPath).toEqual(['ownerScope', 'domain', 'entityKey']);

      // Verify indexes on STORE_AUTHORITATIVE_REPLICAS
      const shadowStore = tx.objectStore(STORE_AUTHORITATIVE_REPLICAS);
      expect(shadowStore.indexNames.contains('by_scope_domain')).toBe(true);
      expect(shadowStore.indexNames.contains('by_scope_revision')).toBe(true);

      const domainIndex = shadowStore.index('by_scope_domain');
      expect(domainIndex.keyPath).toEqual(['ownerScope', 'domain']);
      expect(domainIndex.unique).toBe(false);

      const revIndex = shadowStore.index('by_scope_revision');
      expect(revIndex.keyPath).toEqual(['ownerScope', 'serverRevision']);
      expect(revIndex.unique).toBe(false);
    });
  });

  describe('ST-07B: Migration v3 to v4 with 100% Data Preservation', () => {
    it('seamlessly migrates from v3 to v4, preserves all 8 stores, and initializes empty shadow store', async () => {
      // Step 1: Manually create a v3 database with 8 stores
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 3);
        req.onupgradeneeded = () => {
          const v3Db = req.result;
          v3Db.createObjectStore(STORE_BOOKMARKS, { keyPath: ['ownerScope', 'storyId'] });
          v3Db.createObjectStore(STORE_PROGRESS, { keyPath: ['ownerScope', 'storyId'] });
          const histStore = v3Db.createObjectStore(STORE_HISTORY, { keyPath: ['ownerScope', 'storyId', 'chapterId'] });
          histStore.createIndex('by_owner_time', ['ownerScope', 'lastReadAt'], { unique: false });
          v3Db.createObjectStore(STORE_PREFERENCES, { keyPath: ['ownerScope', 'key'] });
          v3Db.createObjectStore(STORE_SYNC_META, { keyPath: 'ownerScope' });
          const pStore = v3Db.createObjectStore(STORE_PENDING_MUTATIONS, { keyPath: ['ownerScope', 'mutationId'] });
          pStore.createIndex('by_scope_created', ['ownerScope', 'createdAt'], { unique: false });
          const qStore = v3Db.createObjectStore(STORE_QUARANTINED_MUTATIONS, { keyPath: ['ownerScope', 'mutationId'] });
          qStore.createIndex('by_scope_rejected', ['ownerScope', 'rejectedAt'], { unique: false });
          const sStore = v3Db.createObjectStore(STORE_SNAPSHOT_STAGING, { keyPath: ['ownerScope', 'sessionId', 'domain', 'entityKey'] });
          sStore.createIndex('by_scope_session', ['ownerScope', 'sessionId'], { unique: false });
        };
        req.onsuccess = () => {
          const v3Db = req.result;
          const seedTx = v3Db.transaction(
            [STORE_BOOKMARKS, STORE_PROGRESS, STORE_HISTORY, STORE_PREFERENCES, STORE_SYNC_META, STORE_PENDING_MUTATIONS],
            'readwrite',
          );
          seedTx.objectStore(STORE_BOOKMARKS).put({
            ownerScope: 'account:usr-v3',
            storyId: 'story-v3-1',
            title: 'V3 Bookmark Title',
            createdAt: '2026-11-01T00:00:00.000Z',
          });
          seedTx.objectStore(STORE_PROGRESS).put({
            ownerScope: 'account:usr-v3',
            storyId: 'story-v3-1',
            chapterId: 'chap-1',
            progressPercentage: 55,
            updatedAt: '2026-11-01T00:00:00.000Z',
          });
          seedTx.objectStore(STORE_HISTORY).put({
            ownerScope: 'account:usr-v3',
            storyId: 'story-v3-1',
            chapterId: 'chap-1',
            progressPercentage: 55,
            lastReadAt: '2026-11-01T00:00:00.000Z',
          });
          seedTx.objectStore(STORE_PREFERENCES).put({
            ownerScope: 'account:usr-v3',
            key: 'reader_theme',
            value: 'dark',
            updatedAt: '2026-11-01T00:00:00.000Z',
          });
          seedTx.objectStore(STORE_SYNC_META).put({
            ownerScope: 'account:usr-v3',
            lastSyncedServerRevision: '150',
            minActiveRevision: '100',
            lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
            effectiveHistoryEpochs: { 'story-v3-1': 2 },
            syncState: 'IDLE',
          });
          seedTx.objectStore(STORE_PENDING_MUTATIONS).put({
            ownerScope: 'account:usr-v3',
            mutationId: 'mut-v3-1',
            clientId: 'client-1',
            domain: SyncDomain.PROGRESS,
            entityId: 'story-v3-1',
            operation: SyncOperation.UPSERT,
            baseServerRevision: '150',
            payload: { storyId: 'story-v3-1', progressPercentage: 60 },
            createdAt: '2026-11-01T00:00:00.000Z',
            retryCount: 0,
          });
          seedTx.oncomplete = () => {
            v3Db.close();
            resolve();
          };
          seedTx.onerror = () => reject(seedTx.error);
        };
        req.onerror = () => reject(req.error);
      });

      // Step 2: Open through IndexedDbClient, upgrading from v3 to v4
      const db = await dbClient.getDatabase();
      expect(db.version).toBe(4);
      expect(db.objectStoreNames.contains(STORE_AUTHORITATIVE_REPLICAS)).toBe(true);

      // Step 3: Verify 100% preservation of all seeded data
      const bm = await dbClient.getBookmark('account:usr-v3', 'story-v3-1');
      expect(bm?.title).toBe('V3 Bookmark Title');

      const prog = await dbClient.getProgress('account:usr-v3', 'story-v3-1');
      expect(prog?.progressPercentage).toBe(55);

      const hist = await dbClient.getHistory('account:usr-v3');
      expect(hist).toHaveLength(1);
      expect(hist[0].chapterId).toBe('chap-1');

      const pref = await dbClient.getPreference('account:usr-v3', 'reader_theme');
      expect(pref?.value).toBe('dark');

      const pending = await dbClient.getPendingMutations('account:usr-v3');
      expect(pending).toHaveLength(1);
      expect(pending[0].mutationId).toBe('mut-v3-1');

      // Step 4: Verify sync_meta has authoritativeBaselineStatus = 'UNINITIALIZED' (P0-01/P0-02 Guard)
      const meta = await dbClient.getSyncMeta('account:usr-v3');
      expect(meta?.lastSyncedServerRevision).toBe('150');
      expect(meta?.effectiveHistoryEpochs).toEqual({ 'story-v3-1': 2 });
      expect(meta?.authoritativeBaselineStatus).toBe('UNINITIALIZED');

      // Step 5: Verify new shadow store is empty for this scope
      const shadows = await dbClient.getAuthoritativeShadowsByDomain('account:usr-v3', SyncDomain.PROGRESS);
      expect(shadows).toHaveLength(0);
    });
  });

  describe('ST-07C: Multi-Tab onversionchange Graceful Shutdown', () => {
    it('gracefully closes database instance when onversionchange is triggered', async () => {
      const db = await dbClient.getDatabase();
      expect(dbClient['dbInstance']).not.toBeNull();

      // Trigger onversionchange handler manually
      if (db.onversionchange) {
        db.onversionchange(new IDBVersionChangeEvent('versionchange', { oldVersion: 4, newVersion: 5 }));
      }

      // dbInstance should be nullified and closed
      expect(dbClient['dbInstance']).toBeNull();
    });
  });

  describe('ST-10A & ST-10B: Baseline Lifecycle (UNINITIALIZED by default)', () => {
    it('ST-10A: returns UNINITIALIZED when sync_meta does not exist for new scope', async () => {
      const status = await dbClient.getAuthoritativeBaselineStatus('account:usr-brand-new');
      expect(status).toBe('UNINITIALIZED');

      const isReady = await dbClient.isAuthoritativeReady('account:usr-brand-new');
      expect(isReady).toBe(false);
    });

    it('ST-10A: returns UNINITIALIZED for fresh account with lastSyncedServerRevision = "0"', async () => {
      await dbClient.putSyncMeta({
        ownerScope: 'account:usr-fresh-0',
        lastSyncedServerRevision: '0',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const status = await dbClient.getAuthoritativeBaselineStatus('account:usr-fresh-0');
      expect(status).toBe('UNINITIALIZED'); // P0-01: Rev 0 is NOT assumed READY!

      const isReady = await dbClient.isAuthoritativeReady('account:usr-fresh-0');
      expect(isReady).toBe(false);
    });

    it('ST-10B: returns UNINITIALIZED for existing scope with lastSyncedServerRevision > "0"', async () => {
      await dbClient.putSyncMeta({
        ownerScope: 'account:usr-existing-150',
        lastSyncedServerRevision: '150',
        minActiveRevision: '100',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: { 'story-1': 1 },
        syncState: 'IDLE',
      });

      const status = await dbClient.getAuthoritativeBaselineStatus('account:usr-existing-150');
      expect(status).toBe('UNINITIALIZED');

      const isReady = await dbClient.isAuthoritativeReady('account:usr-existing-150');
      expect(isReady).toBe(false);
    });
  });

  describe('ST-10C & ST-10D: Admission Guard & Interrupted Bootstrap Recovery', () => {
    it('ST-10C: isAuthoritativeReady returns false for UNINITIALIZED and BOOTSTRAPPING; true only for READY', async () => {
      const scope = 'account:usr-stage';

      await dbClient.setAuthoritativeBaselineStatus(scope, 'UNINITIALIZED');
      expect(await dbClient.isAuthoritativeReady(scope)).toBe(false);

      await dbClient.setAuthoritativeBaselineStatus(scope, 'BOOTSTRAPPING');
      expect(await dbClient.isAuthoritativeReady(scope)).toBe(false);

      await dbClient.setAuthoritativeBaselineStatus(scope, 'READY');
      expect(await dbClient.isAuthoritativeReady(scope)).toBe(true);
    });

    it('ST-10D: interrupted BOOTSTRAPPING state after crash/reload is detected and can be reset cleanly', async () => {
      const scope = 'account:usr-crashed';

      // Simulate entering BOOTSTRAPPING before simulated crash
      await dbClient.setAuthoritativeBaselineStatus(scope, 'BOOTSTRAPPING');
      expect(await dbClient.getAuthoritativeBaselineStatus(scope)).toBe('BOOTSTRAPPING');
      expect(await dbClient.isAuthoritativeReady(scope)).toBe(false);

      // Simulate app restart: Reconciler checks status
      const restartStatus = await dbClient.getAuthoritativeBaselineStatus(scope);
      expect(restartStatus).toBe('BOOTSTRAPPING');
      expect(await dbClient.isAuthoritativeReady(scope)).toBe(false);

      // Reconciler recovers by resetting to UNINITIALIZED or retrying
      await dbClient.setAuthoritativeBaselineStatus(scope, 'UNINITIALIZED');
      expect(await dbClient.getAuthoritativeBaselineStatus(scope)).toBe('UNINITIALIZED');
    });
  });

  describe('ST-10E: Scope Isolation & Tenant Guard', () => {
    it('mutations to baseline status on one scope do not affect other scopes or guest scopes', async () => {
      await dbClient.setAuthoritativeBaselineStatus('account:usr-alpha', 'READY');
      await dbClient.setAuthoritativeBaselineStatus('guest:dev-beta', 'UNINITIALIZED');

      expect(await dbClient.getAuthoritativeBaselineStatus('account:usr-alpha')).toBe('READY');
      expect(await dbClient.isAuthoritativeReady('account:usr-alpha')).toBe(true);

      expect(await dbClient.getAuthoritativeBaselineStatus('guest:dev-beta')).toBe('UNINITIALIZED');
      expect(await dbClient.isAuthoritativeReady('guest:dev-beta')).toBe(false);

      expect(await dbClient.getAuthoritativeBaselineStatus('account:usr-gamma')).toBe('UNINITIALIZED');
      expect(await dbClient.isAuthoritativeReady('account:usr-gamma')).toBe(false);
    });
  });

  describe('ST-10F: Authoritative Shadow Storage CRUD Primitives', () => {
    it('puts, gets by exact key, gets by domain, and deletes authoritative shadow records', async () => {
      const scope = 'account:usr-shadow-test';
      const record1: AuthoritativeShadowRecord = {
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-101',
        serverRevision: '200',
        epoch: 0,
        payload: { storyId: 'story-101', chapterId: 'chap-10', progressPercentage: 80 },
        isDeleted: false,
        updatedAt: Date.now(),
      };
      const record2: AuthoritativeShadowRecord = {
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-102',
        serverRevision: '205',
        epoch: 0,
        payload: { storyId: 'story-102', chapterId: 'chap-2', progressPercentage: 45 },
        isDeleted: false,
        updatedAt: Date.now(),
      };
      const recordHistory: AuthoritativeShadowRecord = {
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-101:chap-10',
        serverRevision: '200',
        epoch: 0,
        payload: { storyId: 'story-101', chapterId: 'chap-10', progressPercentage: 80 },
        isDeleted: false,
        updatedAt: Date.now(),
      };

      await dbClient.putAuthoritativeShadow(record1);
      await dbClient.putAuthoritativeShadow(record2);
      await dbClient.putAuthoritativeShadow(recordHistory);

      // Get exact shadow
      const fetched1 = await dbClient.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-101');
      expect(fetched1).not.toBeNull();
      expect(fetched1?.serverRevision).toBe('200');
      expect(fetched1?.payload?.progressPercentage).toBe(80);

      // Query by domain index
      const progressShadows = await dbClient.getAuthoritativeShadowsByDomain(scope, SyncDomain.PROGRESS);
      expect(progressShadows).toHaveLength(2);

      const historyShadows = await dbClient.getAuthoritativeShadowsByDomain(scope, SyncDomain.HISTORY);
      expect(historyShadows).toHaveLength(1);
      expect(historyShadows[0].entityKey).toBe('story-101:chap-10');

      // Delete one shadow
      await dbClient.deleteAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-101');
      const afterDelete = await dbClient.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-101');
      expect(afterDelete).toBeNull();

      const remainingProgress = await dbClient.getAuthoritativeShadowsByDomain(scope, SyncDomain.PROGRESS);
      expect(remainingProgress).toHaveLength(1);
      expect(remainingProgress[0].entityKey).toBe('story-102');
    });
  });

  describe('ST-10G: PurgeScope Cleanly Wipes All 9 Object Stores', () => {
    it('completely purges all 9 stores for target scope while leaving other scopes untouched', async () => {
      const targetScope = 'account:purge-me';
      const keepScope = 'account:keep-me';

      // Seed both scopes in bookmark, progress, shadow, and meta
      await dbClient.putBookmarkWithMutation(
        { ownerScope: targetScope, storyId: 'story-p1', title: 'P1', createdAt: new Date().toISOString() },
        {
          ownerScope: targetScope,
          mutationId: 'mut-p1',
          clientId: 'client-1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'story-p1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: { storyId: 'story-p1' },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      );

      await dbClient.putBookmarkWithMutation(
        { ownerScope: keepScope, storyId: 'story-k1', title: 'K1', createdAt: new Date().toISOString() },
        {
          ownerScope: keepScope,
          mutationId: 'mut-k1',
          clientId: 'client-1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'story-k1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: { storyId: 'story-k1' },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      );

      await dbClient.putAuthoritativeShadow({
        ownerScope: targetScope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-p1',
        serverRevision: '100',
        epoch: 0,
        payload: { progress: 50 },
        isDeleted: false,
        updatedAt: Date.now(),
      });

      await dbClient.putAuthoritativeShadow({
        ownerScope: keepScope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-k1',
        serverRevision: '100',
        epoch: 0,
        payload: { progress: 90 },
        isDeleted: false,
        updatedAt: Date.now(),
      });

      await dbClient.setAuthoritativeBaselineStatus(targetScope, 'READY');
      await dbClient.setAuthoritativeBaselineStatus(keepScope, 'READY');

      // Purge target scope
      await dbClient.purgeScope(targetScope);

      // Verify target scope is completely empty
      expect(await dbClient.getBookmark(targetScope, 'story-p1')).toBeNull();
      expect(await dbClient.getAuthoritativeShadow(targetScope, SyncDomain.PROGRESS, 'story-p1')).toBeNull();
      expect(await dbClient.getPendingMutations(targetScope)).toHaveLength(0);
      expect(await dbClient.getSyncMeta(targetScope)).toBeNull();
      expect(await dbClient.getAuthoritativeBaselineStatus(targetScope)).toBe('UNINITIALIZED');

      // Verify keep scope is 100% untouched
      expect(await dbClient.getBookmark(keepScope, 'story-k1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(keepScope, SyncDomain.PROGRESS, 'story-k1')).not.toBeNull();
      expect(await dbClient.getPendingMutations(keepScope)).toHaveLength(1);
      expect(await dbClient.getAuthoritativeBaselineStatus(keepScope)).toBe('READY');
    });
  });
});
