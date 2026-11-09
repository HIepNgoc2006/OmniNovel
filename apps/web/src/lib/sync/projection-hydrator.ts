import {
  LocalBookmark,
  LocalReadingHistory,
  LocalReadingProgress,
  SyncDomain,
} from '@omninovel/shared';
import {
  AuthoritativeBaselineStatus,
  AuthoritativeShadowRecord,
  IndexedDbClient,
  LocalPendingMutation,
  LocalPreference,
  LocalSyncMeta,
  STORE_AUTHORITATIVE_REPLICAS,
  STORE_BOOKMARKS,
  STORE_HISTORY,
  STORE_PENDING_MUTATIONS,
  STORE_PREFERENCES,
  STORE_PROGRESS,
  STORE_SYNC_META,
  assertValidScope,
  indexedDbClient,
  isValidRevisionString,
} from '../storage/indexed-db-client';
import {
  CausalProjectionResult,
  DEFAULT_POST_RECEIPT_GRACE_TTL_MS,
  GraceProjectionEntry,
  PresentationCatalog,
  ProjectedBookmark,
  ProjectedPreference,
  ProjectedReadingHistory,
  ProjectedReadingProgress,
  resolveCausalProjection,
} from './causal-projection-engine';

export type ProjectionMode = 'AUTHORITATIVE_PROJECTION' | 'DEGRADED_COMPATIBILITY';

export interface HydrateScopeOptions {
  tombstoneRevisions?: Partial<Record<SyncDomain, Record<string, string>>>;
  catalog?: PresentationCatalog;
  nowMs?: number;
}

export interface HydratedProjectionResult {
  ownerScope: string;
  mode: ProjectionMode;
  baselineStatus: AuthoritativeBaselineStatus;
  syncedServerRevision: string;
  effectiveHistoryEpochs: Record<string, number>;
  bookmarks: ProjectedBookmark[];
  progress: ProjectedReadingProgress[];
  history: ProjectedReadingHistory[];
  preferences: ProjectedPreference[];
  suppressedMutationCount: number;
  activeGraceCount: number;
  pendingMutationCount: number;
}

export interface MaterializeScopeOptions extends HydrateScopeOptions {
  checkAdmission?: () => void;
  /**
   * Test-only hook executed after getDatabase() and before acquiring the single readwrite transaction,
   * allowing deterministic concurrency simulation for ST-15.
   */
  _testHookBeforeTransaction?: () => Promise<void> | void;
}

export interface MaterializeResult {
  ownerScope: string;
  materialized: boolean;
  mode: ProjectionMode;
  baselineStatus: AuthoritativeBaselineStatus;
  preservedPendingKeys: string[];
  writtenCounts: {
    bookmarks: number;
    progress: number;
    history: number;
    preferences: number;
  };
  deletedCounts: {
    bookmarks: number;
    progress: number;
    history: number;
    preferences: number;
  };
}

interface ScopedDatabaseSnapshot {
  syncMeta: LocalSyncMeta | null;
  shadows: AuthoritativeShadowRecord[];
  pendingMutations: LocalPendingMutation[];
  legacyBookmarks: LocalBookmark[];
  legacyProgress: LocalReadingProgress[];
  legacyHistory: LocalReadingHistory[];
  legacyPreferences: LocalPreference[];
}

function parseIsoMs(iso?: string): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scanCompositeStoreByScope<T extends { ownerScope: string }>(
  store: IDBObjectStore,
  ownerScope: string,
  onDone: (items: T[]) => void,
  onError: (err: unknown) => void,
): void {
  try {
    const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
    const req = store.openCursor(range);
    const items: T[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const val = cursor.value as T;
        if (val && val.ownerScope === ownerScope) {
          items.push(val);
        }
        cursor.continue();
      } else {
        onDone(items);
      }
    };
    req.onerror = () => {
      onError(req.error || new Error(`Failed scanning store "${store.name}" for scope "${ownerScope}".`));
    };
  } catch (err) {
    onError(err);
  }
}

function readScopedSnapshotInTransaction(
  tx: IDBTransaction,
  ownerScope: string,
  onLoaded: (snapshot: ScopedDatabaseSnapshot) => void,
  onError: (err: unknown) => void,
): void {
  let remaining = 7;
  let aborted = false;

  const snapshot: ScopedDatabaseSnapshot = {
    syncMeta: null,
    shadows: [],
    pendingMutations: [],
    legacyBookmarks: [],
    legacyProgress: [],
    legacyHistory: [],
    legacyPreferences: [],
  };

  const fail = (err: unknown) => {
    if (!aborted) {
      aborted = true;
      onError(err);
    }
  };

  const finishOne = () => {
    if (aborted) return;
    remaining -= 1;
    if (remaining === 0) {
      onLoaded(snapshot);
    }
  };

  try {
    const metaReq = tx.objectStore(STORE_SYNC_META).get(ownerScope);
    metaReq.onsuccess = () => {
      snapshot.syncMeta = (metaReq.result as LocalSyncMeta | undefined) ?? null;
      finishOne();
    };
    metaReq.onerror = () => {
      fail(metaReq.error || new Error('Failed reading sync_meta during hydration.'));
    };

    scanCompositeStoreByScope<AuthoritativeShadowRecord>(
      tx.objectStore(STORE_AUTHORITATIVE_REPLICAS),
      ownerScope,
      (items) => {
        snapshot.shadows = items;
        finishOne();
      },
      fail,
    );

    scanCompositeStoreByScope<LocalPendingMutation>(
      tx.objectStore(STORE_PENDING_MUTATIONS),
      ownerScope,
      (items) => {
        snapshot.pendingMutations = items;
        finishOne();
      },
      fail,
    );

    scanCompositeStoreByScope<LocalBookmark>(
      tx.objectStore(STORE_BOOKMARKS),
      ownerScope,
      (items) => {
        snapshot.legacyBookmarks = items;
        finishOne();
      },
      fail,
    );

    scanCompositeStoreByScope<LocalReadingProgress>(
      tx.objectStore(STORE_PROGRESS),
      ownerScope,
      (items) => {
        snapshot.legacyProgress = items;
        finishOne();
      },
      fail,
    );

    scanCompositeStoreByScope<LocalReadingHistory>(
      tx.objectStore(STORE_HISTORY),
      ownerScope,
      (items) => {
        snapshot.legacyHistory = items;
        finishOne();
      },
      fail,
    );

    scanCompositeStoreByScope<LocalPreference>(
      tx.objectStore(STORE_PREFERENCES),
      ownerScope,
      (items) => {
        snapshot.legacyPreferences = items;
        finishOne();
      },
      fail,
    );
  } catch (err) {
    fail(err);
  }
}

function buildPresentationCatalog(
  snapshot: ScopedDatabaseSnapshot,
  explicitCatalog?: PresentationCatalog,
): PresentationCatalog {
  const stories: Record<string, { title?: string; slug?: string; coverUrl?: string }> = {};
  const chapters: Record<string, { chapterNumber?: string | number; chapterTitle?: string }> = {};

  for (const bm of snapshot.legacyBookmarks) {
    if (bm.title) {
      stories[bm.storyId] = {
        title: bm.title,
        slug: bm.slug,
        coverUrl: bm.coverUrl,
      };
    }
  }

  for (const hist of snapshot.legacyHistory) {
    if (hist.storyTitle && !stories[hist.storyId]) {
      stories[hist.storyId] = {
        title: hist.storyTitle,
        slug: hist.storySlug,
        coverUrl: hist.storyCoverUrl,
      };
    }
    if (hist.chapterId && !chapters[hist.chapterId]) {
      chapters[hist.chapterId] = {
        chapterNumber: hist.chapterNumber,
        chapterTitle: hist.chapterTitle,
      };
    }
  }

  if (explicitCatalog?.stories) {
    for (const [k, v] of Object.entries(explicitCatalog.stories)) {
      stories[k] = { ...stories[k], ...v };
    }
  }
  if (explicitCatalog?.chapters) {
    for (const [k, v] of Object.entries(explicitCatalog.chapters)) {
      chapters[k] = { ...chapters[k], ...v };
    }
  }

  return { stories, chapters };
}

function toLegacyBookmark(bm: ProjectedBookmark): LocalBookmark {
  return {
    ownerScope: bm.ownerScope,
    storyId: bm.storyId,
    title: bm.title,
    ...(bm.slug !== undefined ? { slug: bm.slug } : {}),
    ...(bm.coverUrl !== undefined ? { coverUrl: bm.coverUrl } : {}),
    createdAt: bm.createdAt,
  };
}

function toLegacyProgress(prog: ProjectedReadingProgress): LocalReadingProgress {
  return {
    ownerScope: prog.ownerScope,
    storyId: prog.storyId,
    chapterId: prog.chapterId,
    chapterVersionId: prog.chapterVersionId ?? null,
    readingMode: prog.readingMode,
    progressPercentage: prog.progressPercentage,
    scrollPosition: prog.scrollPosition,
    pageIndex: prog.pageIndex,
    anchorBlockId: prog.anchorBlockId ?? null,
    textOffset: prog.textOffset ?? null,
    updatedAt: prog.updatedAt,
    deviceTimestamp: prog.deviceTimestamp,
  };
}

function toLegacyHistory(hist: ProjectedReadingHistory): LocalReadingHistory {
  return {
    ownerScope: hist.ownerScope,
    storyId: hist.storyId,
    chapterId: hist.chapterId,
    chapterVersionId: hist.chapterVersionId ?? null,
    storyTitle: hist.storyTitle,
    ...(hist.storySlug !== undefined ? { storySlug: hist.storySlug } : {}),
    ...(hist.storyCoverUrl !== undefined ? { storyCoverUrl: hist.storyCoverUrl } : {}),
    chapterNumber: hist.chapterNumber,
    ...(hist.chapterTitle !== undefined ? { chapterTitle: hist.chapterTitle } : {}),
    progressPercentage: hist.progressPercentage,
    lastReadAt: hist.lastReadAt,
  };
}

function toLegacyPreference(pref: ProjectedPreference): LocalPreference {
  return {
    ownerScope: pref.ownerScope,
    key: pref.key,
    value: pref.value,
    updatedAt: pref.updatedAt,
  };
}

/**
 * Step 5.2c Hydrator & Selective Materializer.
 *
 * Reads committed IndexedDB stores atomically inside a single transaction and computes
 * deterministic projection without relying on RAM callbacks or tab event history.
 * Fails closed into DEGRADED_COMPATIBILITY mode whenever baseline !== 'READY'.
 */
export class SyncProjectionHydrator {
  private readonly graceEntriesByScope = new Map<string, GraceProjectionEntry[]>();

  constructor(
    private readonly dbClient: IndexedDbClient = indexedDbClient,
    private readonly nowProvider: () => number = () => Date.now(),
  ) {}

  /**
   * Records a short-lived in-session grace projection entry after an APPLIED server receipt
   * so active UI does not flicker backwards before Delta Pull reaches assignedRevision.
   *
   * Note: Strictly in-session and bounded by TTL & syncedRevision; reloads instantiate
   * a fresh hydrator that derives truth deterministically from committed IndexedDB only.
   */
  recordAppliedGrace(
    ownerScope: string,
    mutation: LocalPendingMutation,
    assignedRevision: string,
    ttlMs: number = DEFAULT_POST_RECEIPT_GRACE_TTL_MS,
  ): void {
    assertValidScope(ownerScope);
    if (!isValidRevisionString(assignedRevision) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return;
    }

    const nowMs = this.nowProvider();
    const existing = (this.graceEntriesByScope.get(ownerScope) ?? []).filter(
      (entry) => entry.expiresAtMs > nowMs && entry.mutation.mutationId !== mutation.mutationId,
    );

    existing.push({
      ownerScope,
      mutation,
      assignedRevision,
      recordedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    });
    this.graceEntriesByScope.set(ownerScope, existing);
  }

  clearGraceForScope(ownerScope: string): void {
    this.graceEntriesByScope.delete(ownerScope);
  }

  clearAllGrace(): void {
    this.graceEntriesByScope.clear();
  }

  private getPrunedGraceEntries(
    ownerScope: string,
    syncedRevision: string,
    nowMs: number,
  ): GraceProjectionEntry[] {
    const entries = this.graceEntriesByScope.get(ownerScope);
    if (!entries || entries.length === 0) return [];

    const syncedBigInt = isValidRevisionString(syncedRevision) ? BigInt(syncedRevision) : 0n;
    const retained = entries.filter((entry) => {
      if (!Number.isFinite(nowMs) || !Number.isFinite(entry.expiresAtMs) || nowMs >= entry.expiresAtMs) {
        return false;
      }
      const assignedBigInt = isValidRevisionString(entry.assignedRevision)
        ? BigInt(entry.assignedRevision)
        : 0n;
      return syncedBigInt < assignedBigInt;
    });

    if (retained.length === 0) {
      this.graceEntriesByScope.delete(ownerScope);
    } else {
      this.graceEntriesByScope.set(ownerScope, retained);
    }
    return retained;
  }

  async hydrateScope(
    ownerScope: string,
    options?: HydrateScopeOptions,
  ): Promise<HydratedProjectionResult> {
    assertValidScope(ownerScope);

    const db = await this.dbClient.getDatabase();
    const nowMs = options?.nowMs ?? this.nowProvider();

    const snapshot = await new Promise<ScopedDatabaseSnapshot>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          reject(err);
        }
      };

      let tx: IDBTransaction;
      try {
        tx = db.transaction(
          [
            STORE_SYNC_META,
            STORE_AUTHORITATIVE_REPLICAS,
            STORE_PENDING_MUTATIONS,
            STORE_BOOKMARKS,
            STORE_PROGRESS,
            STORE_HISTORY,
            STORE_PREFERENCES,
          ],
          'readonly',
        );
      } catch (err) {
        reject(err);
        return;
      }

      let loadedSnapshot: ScopedDatabaseSnapshot | null = null;
      tx.onerror = () => fail(tx.error || new Error('Hydration transaction failed.'));
      tx.onabort = () => fail(tx.error || new Error('Hydration transaction aborted.'));
      tx.oncomplete = () => {
        if (!settled && loadedSnapshot) {
          settled = true;
          resolve(loadedSnapshot);
        }
      };

      readScopedSnapshotInTransaction(
        tx,
        ownerScope,
        (loaded) => {
          loadedSnapshot = loaded;
        },
        fail,
      );
    });

    const baselineStatus: AuthoritativeBaselineStatus =
      snapshot.syncMeta?.authoritativeBaselineStatus || 'UNINITIALIZED';
    const syncedRevision = snapshot.syncMeta?.lastSyncedServerRevision || '0';
    const effectiveEpochs = { ...(snapshot.syncMeta?.effectiveHistoryEpochs || {}) };

    // Fail-closed Degraded Compatibility Mode whenever baseline !== READY (Revision 2.2 P0-01)
    if (baselineStatus !== 'READY') {
      return {
        ownerScope,
        mode: 'DEGRADED_COMPATIBILITY',
        baselineStatus,
        syncedServerRevision: syncedRevision,
        effectiveHistoryEpochs: effectiveEpochs,
        bookmarks: [...snapshot.legacyBookmarks]
          .sort((a, b) => {
            const diff = parseIsoMs(b.createdAt) - parseIsoMs(a.createdAt);
            return diff !== 0 ? diff : a.storyId.localeCompare(b.storyId);
          })
          .map((bm) => ({
            ...bm,
            source: 'LEGACY',
            needsHydration: !bm.title || bm.title.trim().length === 0,
          })),
        progress: [...snapshot.legacyProgress]
          .sort((a, b) => {
            const diff = parseIsoMs(b.updatedAt) - parseIsoMs(a.updatedAt);
            return diff !== 0 ? diff : a.storyId.localeCompare(b.storyId);
          })
          .map((p) => ({
            ...p,
            source: 'LEGACY',
            epoch: 0,
            needsHydration: false,
          })),
        history: [...snapshot.legacyHistory]
          .sort((a, b) => {
            const diff = parseIsoMs(b.lastReadAt) - parseIsoMs(a.lastReadAt);
            if (diff !== 0) return diff;
            if (a.storyId !== b.storyId) return a.storyId.localeCompare(b.storyId);
            return a.chapterId.localeCompare(b.chapterId);
          })
          .map((h) => ({
            ...h,
            source: 'LEGACY',
            epoch: 0,
            needsHydration: !h.storyTitle || h.storyTitle.trim().length === 0,
          })),
        preferences: [...snapshot.legacyPreferences]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((pref) => ({
            ...pref,
            source: 'LEGACY',
          })),
        suppressedMutationCount: 0,
        activeGraceCount: 0,
        pendingMutationCount: snapshot.pendingMutations.length,
      };
    }

    const activeGrace = this.getPrunedGraceEntries(ownerScope, syncedRevision, nowMs);
    const catalog = buildPresentationCatalog(snapshot, options?.catalog);

    const projected: CausalProjectionResult = resolveCausalProjection({
      ownerScope,
      syncedServerRevision: syncedRevision,
      effectiveHistoryEpochs: effectiveEpochs,
      shadows: snapshot.shadows,
      pendingMutations: snapshot.pendingMutations,
      graceEntries: activeGrace,
      tombstoneRevisions: options?.tombstoneRevisions,
      catalog,
      nowMs,
    });

    return {
      ownerScope,
      mode: 'AUTHORITATIVE_PROJECTION',
      baselineStatus: 'READY',
      syncedServerRevision: projected.syncedServerRevision,
      effectiveHistoryEpochs: projected.effectiveHistoryEpochs,
      bookmarks: projected.bookmarks,
      progress: projected.progress,
      history: projected.history,
      preferences: projected.preferences,
      suppressedMutationCount: projected.suppressedMutationCount,
      activeGraceCount: projected.activeGraceCount,
      pendingMutationCount: projected.pendingMutationCount,
    };
  }

  /**
   * Atomically materializes projected state back to legacy stores inside ONE single readwrite
   * IndexedDB transaction, reading fresh pending_mutations and legacy stores under the lock so
   * concurrent local user writes (ST-15) are NEVER overwritten.
   */
  async materializeToLegacyStores(
    ownerScope: string,
    options?: MaterializeScopeOptions,
  ): Promise<MaterializeResult> {
    assertValidScope(ownerScope);

    options?.checkAdmission?.();
    const db = await this.dbClient.getDatabase();

    if (options?._testHookBeforeTransaction) {
      await options._testHookBeforeTransaction();
    }

    options?.checkAdmission?.();
    const nowMs = options?.nowMs ?? this.nowProvider();

    return new Promise<MaterializeResult>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          reject(err);
        }
      };

      let tx: IDBTransaction;
      try {
        tx = db.transaction(
          [
            STORE_SYNC_META,
            STORE_AUTHORITATIVE_REPLICAS,
            STORE_PENDING_MUTATIONS,
            STORE_BOOKMARKS,
            STORE_PROGRESS,
            STORE_HISTORY,
            STORE_PREFERENCES,
          ],
          'readwrite',
        );
      } catch (err) {
        reject(err);
        return;
      }

      let result: MaterializeResult | null = null;
      tx.onerror = () => fail(tx.error || new Error('Materialization transaction failed.'));
      tx.onabort = () => fail(tx.error || new Error('Materialization transaction aborted.'));
      tx.oncomplete = () => {
        if (!settled && result) {
          settled = true;
          resolve(result);
        }
      };

      readScopedSnapshotInTransaction(
        tx,
        ownerScope,
        (snapshot) => {
          try {
            const baselineStatus: AuthoritativeBaselineStatus =
              snapshot.syncMeta?.authoritativeBaselineStatus || 'UNINITIALIZED';

            // Fail-closed: NEVER materialize over legacy stores when baseline !== READY
            if (baselineStatus !== 'READY') {
              result = {
                ownerScope,
                materialized: false,
                mode: 'DEGRADED_COMPATIBILITY',
                baselineStatus,
                preservedPendingKeys: [],
                writtenCounts: { bookmarks: 0, progress: 0, history: 0, preferences: 0 },
                deletedCounts: { bookmarks: 0, progress: 0, history: 0, preferences: 0 },
              };
              return;
            }

            const syncedRevision = snapshot.syncMeta?.lastSyncedServerRevision || '0';
            const activeGrace = this.getPrunedGraceEntries(ownerScope, syncedRevision, nowMs);
            const catalog = buildPresentationCatalog(snapshot, options?.catalog);

            const projected = resolveCausalProjection({
              ownerScope,
              syncedServerRevision: syncedRevision,
              effectiveHistoryEpochs: snapshot.syncMeta?.effectiveHistoryEpochs || {},
              shadows: snapshot.shadows,
              pendingMutations: snapshot.pendingMutations,
              graceEntries: activeGrace,
              tombstoneRevisions: options?.tombstoneRevisions,
              catalog,
              nowMs,
            });

            const protectedBmSet = new Set(projected.protectedPending.BOOKMARK);
            const protectedProgSet = new Set(projected.protectedPending.PROGRESS);
            const protectedHistSet = new Set(projected.protectedPending.HISTORY);
            const protectedPrefSet = new Set(projected.protectedPending.PREFERENCE);

            const writtenCounts = { bookmarks: 0, progress: 0, history: 0, preferences: 0 };
            const deletedCounts = { bookmarks: 0, progress: 0, history: 0, preferences: 0 };
            const preservedPendingKeys: string[] = [];

            // 1. Bookmarks materialization
            const bmStore = tx.objectStore(STORE_BOOKMARKS);
            const existingBmMap = new Map(snapshot.legacyBookmarks.map((b) => [b.storyId, b]));
            const projectedBmMap = new Map(projected.bookmarks.map((b) => [b.storyId, b]));

            for (const bm of projected.bookmarks) {
              if (protectedBmSet.has(bm.storyId) && existingBmMap.has(bm.storyId)) {
                preservedPendingKeys.push(`BOOKMARK:${bm.storyId}`);
                continue;
              }
              bmStore.put(toLegacyBookmark(bm));
              writtenCounts.bookmarks += 1;
            }
            for (const existing of snapshot.legacyBookmarks) {
              if (!projectedBmMap.has(existing.storyId)) {
                bmStore.delete([ownerScope, existing.storyId]);
                deletedCounts.bookmarks += 1;
              }
            }

            // 2. Reading Progress materialization
            const progStore = tx.objectStore(STORE_PROGRESS);
            const existingProgMap = new Map(snapshot.legacyProgress.map((p) => [p.storyId, p]));
            const projectedProgMap = new Map(projected.progress.map((p) => [p.storyId, p]));

            for (const prog of projected.progress) {
              if (protectedProgSet.has(prog.storyId) && existingProgMap.has(prog.storyId)) {
                preservedPendingKeys.push(`PROGRESS:${prog.storyId}`);
                continue;
              }
              progStore.put(toLegacyProgress(prog));
              writtenCounts.progress += 1;
            }
            for (const existing of snapshot.legacyProgress) {
              if (!projectedProgMap.has(existing.storyId)) {
                progStore.delete([ownerScope, existing.storyId]);
                deletedCounts.progress += 1;
              }
            }

            // 3. Reading History materialization
            const histStore = tx.objectStore(STORE_HISTORY);
            const existingHistMap = new Map(
              snapshot.legacyHistory.map((h) => [`${h.storyId}:${h.chapterId}`, h]),
            );
            const projectedHistMap = new Map(
              projected.history.map((h) => [`${h.storyId}:${h.chapterId}`, h]),
            );

            for (const hist of projected.history) {
              const key = `${hist.storyId}:${hist.chapterId}`;
              if (protectedHistSet.has(key) && existingHistMap.has(key)) {
                preservedPendingKeys.push(`HISTORY:${key}`);
                continue;
              }
              histStore.put(toLegacyHistory(hist));
              writtenCounts.history += 1;
            }
            for (const existing of snapshot.legacyHistory) {
              const key = `${existing.storyId}:${existing.chapterId}`;
              if (!projectedHistMap.has(key)) {
                histStore.delete([ownerScope, existing.storyId, existing.chapterId]);
                deletedCounts.history += 1;
              }
            }

            // 4. Preferences materialization
            const prefStore = tx.objectStore(STORE_PREFERENCES);
            const existingPrefMap = new Map(snapshot.legacyPreferences.map((p) => [p.key, p]));
            const projectedPrefMap = new Map(projected.preferences.map((p) => [p.key, p]));

            for (const pref of projected.preferences) {
              if (protectedPrefSet.has(pref.key) && existingPrefMap.has(pref.key)) {
                preservedPendingKeys.push(`PREFERENCE:${pref.key}`);
                continue;
              }
              prefStore.put(toLegacyPreference(pref));
              writtenCounts.preferences += 1;
            }
            for (const existing of snapshot.legacyPreferences) {
              if (!projectedPrefMap.has(existing.key)) {
                prefStore.delete([ownerScope, existing.key]);
                deletedCounts.preferences += 1;
              }
            }

            // Re-verify admission before committing the readwrite transaction (atomic rollback on revoke)
            options?.checkAdmission?.();

            result = {
              ownerScope,
              materialized: true,
              mode: 'AUTHORITATIVE_PROJECTION',
              baselineStatus: 'READY',
              preservedPendingKeys,
              writtenCounts,
              deletedCounts,
            };
          } catch (err) {
            fail(err);
          }
        },
        fail,
      );
    });
  }
}

export async function hydrateProjectionFromIndexedDb(
  dbClient: IndexedDbClient = indexedDbClient,
  ownerScope: string,
  options?: HydrateScopeOptions,
): Promise<HydratedProjectionResult> {
  const hydrator = new SyncProjectionHydrator(dbClient);
  return hydrator.hydrateScope(ownerScope, options);
}
