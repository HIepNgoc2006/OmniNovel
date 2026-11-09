import {
  LocalBookmark,
  LocalReadingHistory,
  LocalReadingProgress,
  ReadingMode,
  SyncDomain,
  SyncOperation,
} from '@omninovel/shared';
import {
  AuthoritativeShadowRecord,
  LocalPendingMutation,
  LocalPreference,
  assertValidScope,
  isValidRevisionString,
} from '../storage/indexed-db-client';

export const UUID_SENTINEL = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_POST_RECEIPT_GRACE_TTL_MS = 5_000;

const EPOCH_ZERO_ISO = '1970-01-01T00:00:00.000Z';

export type ProjectionSource = 'SHADOW' | 'PENDING' | 'GRACE' | 'LEGACY';

export interface ProjectedBookmark extends LocalBookmark {
  source: ProjectionSource;
  serverRevision?: string;
  needsHydration: boolean;
}

export interface ProjectedReadingProgress extends LocalReadingProgress {
  source: ProjectionSource;
  serverRevision?: string;
  epoch: number;
  needsHydration: boolean;
}

export interface ProjectedReadingHistory extends LocalReadingHistory {
  source: ProjectionSource;
  serverRevision?: string;
  epoch: number;
  needsHydration: boolean;
}

export interface ProjectedPreference extends LocalPreference {
  source: ProjectionSource;
  serverRevision?: string;
}

export interface PresentationCatalog {
  stories?: Record<string, { title?: string; slug?: string; coverUrl?: string }>;
  chapters?: Record<string, { chapterNumber?: string | number; chapterTitle?: string }>;
}

export interface GraceProjectionEntry {
  ownerScope: string;
  mutation: LocalPendingMutation;
  assignedRevision: string;
  recordedAtMs: number;
  expiresAtMs: number;
}

export interface ProtectedPendingEntities {
  BOOKMARK: string[];
  PROGRESS: string[];
  HISTORY: string[];
  PREFERENCE: string[];
}

export interface CausalProjectionInput {
  ownerScope: string;
  syncedServerRevision?: string;
  effectiveHistoryEpochs?: Record<string, number>;
  shadows: AuthoritativeShadowRecord[];
  pendingMutations: LocalPendingMutation[];
  graceEntries?: GraceProjectionEntry[];
  tombstoneRevisions?: Partial<Record<SyncDomain, Record<string, string>>>;
  catalog?: PresentationCatalog;
  /**
   * Caller-supplied epoch milliseconds used deterministically for `graceEntries` TTL evaluation.
   * Fail-closed: if omitted or non-finite when `graceEntries` are present, grace entries are treated
   * as expired instead of lingering indefinitely at `0ms`, preserving pure determinism.
   */
  nowMs?: number;
}

export interface CausalProjectionResult {
  ownerScope: string;
  syncedServerRevision: string;
  effectiveHistoryEpochs: Record<string, number>;
  bookmarks: ProjectedBookmark[];
  progress: ProjectedReadingProgress[];
  history: ProjectedReadingHistory[];
  preferences: ProjectedPreference[];
  suppressedMutationCount: number;
  activeGraceCount: number;
  pendingMutationCount: number;
  protectedPending: ProtectedPendingEntities;
}

export function isGlobalHistorySentinel(entityId: string): boolean {
  return entityId === 'all' || entityId === UUID_SENTINEL;
}

export function getCanonicalEntityKey(
  domain: SyncDomain,
  entityId: string,
  payload?: Record<string, unknown> | null,
): string {
  const safePayload = payload ?? undefined;

  if (domain === SyncDomain.HISTORY) {
    if (isGlobalHistorySentinel(entityId)) {
      return UUID_SENTINEL;
    }
    const storyId = asNonEmptyString(safePayload?.storyId);
    const chapterId = asNonEmptyString(safePayload?.chapterId);
    if (storyId && chapterId) {
      return `${storyId}:${chapterId}`;
    }
    if (entityId.includes(':')) {
      return entityId;
    }
    return storyId ?? entityId;
  }

  if (domain === SyncDomain.BOOKMARK || domain === SyncDomain.PROGRESS) {
    return asNonEmptyString(safePayload?.storyId) ?? entityId;
  }

  if (domain === SyncDomain.PREFERENCE) {
    return asNonEmptyString(safePayload?.key) ?? entityId;
  }

  return entityId;
}

export function getEffectiveHistoryEpoch(
  effectiveHistoryEpochs: Record<string, number> | undefined | null,
  storyId?: string,
): number {
  const globalEpoch = Math.max(
    toNonNegativeInteger(effectiveHistoryEpochs?.[UUID_SENTINEL]),
    toNonNegativeInteger(effectiveHistoryEpochs?.['all']),
  );
  const storyEpoch = storyId ? toNonNegativeInteger(effectiveHistoryEpochs?.[storyId]) : 0;
  return Math.max(storyEpoch, globalEpoch);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

function parseRevisionBigInt(value: unknown): bigint | null {
  if (!isValidRevisionString(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function maxBigInt(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

function clampPercentage(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function resolveTimestampIso(payload: Record<string, unknown>, fallbackMsOrIso: number | string): string {
  const fromPayload =
    asNonEmptyString(payload.updatedAt) ??
    asNonEmptyString(payload.lastReadAt) ??
    asNonEmptyString(payload.createdAt);
  if (fromPayload) return fromPayload;
  if (typeof fallbackMsOrIso === 'string' && fallbackMsOrIso.trim().length > 0) {
    return fallbackMsOrIso;
  }
  if (typeof fallbackMsOrIso === 'number' && Number.isFinite(fallbackMsOrIso)) {
    return new Date(fallbackMsOrIso).toISOString();
  }
  return EPOCH_ZERO_ISO;
}

function pickLatestIso(a?: string, b?: string): string {
  if (!a) return b || EPOCH_ZERO_ISO;
  if (!b) return a;
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (Number.isFinite(pa) && Number.isFinite(pb)) {
    if (pa > pb) return a;
    if (pb > pa) return b;
  }
  return a >= b ? a : b;
}

function parseIsoMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareMutationsChronologically(a: LocalPendingMutation, b: LocalPendingMutation): number {
  const msDiff = parseIsoMs(a.createdAt) - parseIsoMs(b.createdAt);
  if (msDiff !== 0) return msDiff;

  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;

  const revA = parseRevisionBigInt(a.baseServerRevision) ?? 0n;
  const revB = parseRevisionBigInt(b.baseServerRevision) ?? 0n;
  if (revA < revB) return -1;
  if (revA > revB) return 1;

  if (a.mutationId < b.mutationId) return -1;
  if (a.mutationId > b.mutationId) return 1;
  return 0;
}

function extractHistoryStoryAndChapter(
  entityKeyOrId: string,
  payload?: Record<string, unknown> | null,
): { storyId?: string; chapterId?: string } {
  const pStory = asNonEmptyString(payload?.storyId);
  const pChap = asNonEmptyString(payload?.chapterId);
  if (pStory && pChap) {
    return { storyId: pStory, chapterId: pChap };
  }
  const colonIdx = entityKeyOrId.indexOf(':');
  if (colonIdx > 0 && colonIdx < entityKeyOrId.length - 1) {
    const kStory = entityKeyOrId.slice(0, colonIdx).trim();
    const kChap = entityKeyOrId.slice(colonIdx + 1).trim();
    return {
      storyId: pStory ?? (kStory || undefined),
      chapterId: pChap ?? (kChap || undefined),
    };
  }
  return {
    storyId: pStory ?? (!isGlobalHistorySentinel(entityKeyOrId) ? entityKeyOrId : undefined),
    chapterId: pChap,
  };
}

function createEmptyTombstoneMap(): Record<SyncDomain, Map<string, bigint>> {
  return {
    [SyncDomain.BOOKMARK]: new Map(),
    [SyncDomain.PROGRESS]: new Map(),
    [SyncDomain.HISTORY]: new Map(),
    [SyncDomain.PREFERENCE]: new Map(),
    [SyncDomain.FOLLOW]: new Map(),
  };
}

function recordTombstone(
  tombstones: Record<SyncDomain, Map<string, bigint>>,
  domain: SyncDomain,
  key: string,
  revision: bigint | null,
): void {
  if (revision === null) return;
  const map = tombstones[domain];
  if (!map) return;
  const prev = map.get(key) ?? null;
  if (prev === null || revision > prev) {
    map.set(key, revision);
  }
}

function getHistoryTombstoneRevision(
  tombstones: Record<SyncDomain, Map<string, bigint>>,
  storyId: string,
  chapterKey?: string,
): bigint | null {
  let rev = maxBigInt(
    tombstones[SyncDomain.HISTORY].get(UUID_SENTINEL) ?? null,
    tombstones[SyncDomain.HISTORY].get('all') ?? null,
  );
  rev = maxBigInt(rev, tombstones[SyncDomain.HISTORY].get(storyId) ?? null);
  if (chapterKey) {
    rev = maxBigInt(rev, tombstones[SyncDomain.HISTORY].get(chapterKey) ?? null);
  }
  return rev;
}

function getProgressTombstoneRevision(
  tombstones: Record<SyncDomain, Map<string, bigint>>,
  storyId: string,
): bigint | null {
  return maxBigInt(
    tombstones[SyncDomain.PROGRESS].get(storyId) ?? null,
    getHistoryTombstoneRevision(tombstones, storyId),
  );
}

/**
 * Pure Deterministic Causal Projection Engine (Step 5.2c).
 *
 * Computes ProjectedState = Resolve(AuthoritativeShadow, PendingMutations, OptionalGrace)
 * strictly from durable committed inputs, independent of RAM event callbacks or array order.
 */
export function resolveCausalProjection(input: CausalProjectionInput): CausalProjectionResult {
  assertValidScope(input.ownerScope);

  const ownerScope = input.ownerScope;
  const syncedServerRevision = isValidRevisionString(input.syncedServerRevision)
    ? input.syncedServerRevision
    : '0';
  const syncedRevBigInt = BigInt(syncedServerRevision);
  const hasExplicitNowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs);
  const nowMs = hasExplicitNowMs ? (input.nowMs as number) : 0;

  const effectiveEpochs: Record<string, number> = {};
  if (input.effectiveHistoryEpochs) {
    for (const [k, v] of Object.entries(input.effectiveHistoryEpochs)) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
        effectiveEpochs[k] = v;
      }
    }
  }

  const tombstones = createEmptyTombstoneMap();
  if (input.tombstoneRevisions) {
    for (const domainKey of Object.keys(input.tombstoneRevisions) as SyncDomain[]) {
      const entries = input.tombstoneRevisions[domainKey];
      if (!entries) continue;
      for (const [entityKey, revStr] of Object.entries(entries)) {
        const canonical = getCanonicalEntityKey(domainKey, entityKey);
        recordTombstone(tombstones, domainKey, canonical, parseRevisionBigInt(revStr));
      }
    }
  }

  // Filter strictly to ownerScope and sort shadows canonically to guarantee permutation invariance
  const scopedShadows = input.shadows
    .filter((s) => s && s.ownerScope === ownerScope)
    .sort((a, b) => {
      if (a.domain < b.domain) return -1;
      if (a.domain > b.domain) return 1;
      if (a.entityKey < b.entityKey) return -1;
      if (a.entityKey > b.entityKey) return 1;
      const revA = parseRevisionBigInt(a.serverRevision) ?? 0n;
      const revB = parseRevisionBigInt(b.serverRevision) ?? 0n;
      if (revA < revB) return -1;
      if (revA > revB) return 1;
      return (a.isDeleted ? 1 : 0) - (b.isDeleted ? 1 : 0);
    });

  // Deduplicate shadows by (domain, canonicalKey) preserving highest revision and extracting tombstones
  const latestActiveShadows = new Map<string, AuthoritativeShadowRecord>();

  for (const shadow of scopedShadows) {
    const revBig = parseRevisionBigInt(shadow.serverRevision);
    const canonicalKey = getCanonicalEntityKey(shadow.domain, shadow.entityKey, shadow.payload);

    if (shadow.isDeleted) {
      recordTombstone(tombstones, shadow.domain, canonicalKey, revBig);
      if (shadow.domain === SyncDomain.HISTORY) {
        const shadowEpoch = toNonNegativeInteger(shadow.epoch);
        const epochKey = isGlobalHistorySentinel(shadow.entityKey) ? UUID_SENTINEL : canonicalKey;
        effectiveEpochs[epochKey] = Math.max(effectiveEpochs[epochKey] ?? 0, shadowEpoch);
      }
      latestActiveShadows.delete(`${shadow.domain}::${canonicalKey}`);
      continue;
    }

    const composite = `${shadow.domain}::${canonicalKey}`;
    const existing = latestActiveShadows.get(composite);
    const existingRev = existing ? parseRevisionBigInt(existing.serverRevision) : null;
    if (!existing || (revBig !== null && (existingRev === null || revBig >= existingRev))) {
      latestActiveShadows.set(composite, shadow);
    }
  }

  const storiesCatalog = input.catalog?.stories ?? {};
  const chaptersCatalog = input.catalog?.chapters ?? {};

  const bookmarkMap = new Map<string, ProjectedBookmark>();
  const progressMap = new Map<string, ProjectedReadingProgress>();
  const historyMap = new Map<string, ProjectedReadingHistory>();
  const preferenceMap = new Map<string, ProjectedPreference>();

  // Step 1: Materialize Authoritative Shadow records with dual-layer suppression
  for (const shadow of latestActiveShadows.values()) {
    const payload = (shadow.payload ?? {}) as Record<string, unknown>;
    const shadowRev = parseRevisionBigInt(shadow.serverRevision);

    if (shadow.domain === SyncDomain.BOOKMARK) {
      const storyId = getCanonicalEntityKey(SyncDomain.BOOKMARK, shadow.entityKey, payload);
      const tombRev = tombstones[SyncDomain.BOOKMARK].get(storyId) ?? null;
      if (tombRev !== null && shadowRev !== null && shadowRev <= tombRev) {
        continue;
      }

      const catStory = storiesCatalog[storyId];
      const title = asNonEmptyString(payload.title) ?? asNonEmptyString(catStory?.title) ?? '';
      bookmarkMap.set(storyId, {
        ownerScope,
        storyId,
        title,
        slug: asNonEmptyString(payload.slug) ?? asNonEmptyString(catStory?.slug),
        coverUrl: asNonEmptyString(payload.coverUrl) ?? asNonEmptyString(catStory?.coverUrl),
        createdAt: resolveTimestampIso(payload, shadow.updatedAt),
        source: 'SHADOW',
        serverRevision: shadow.serverRevision,
        needsHydration: title.length === 0,
      });
    } else if (shadow.domain === SyncDomain.PROGRESS) {
      const storyId = getCanonicalEntityKey(SyncDomain.PROGRESS, shadow.entityKey, payload);
      const effEpoch = getEffectiveHistoryEpoch(effectiveEpochs, storyId);
      const shadowEpoch = toNonNegativeInteger(shadow.epoch);
      if (shadowEpoch < effEpoch) {
        continue;
      }
      const progTombRev = getProgressTombstoneRevision(tombstones, storyId);
      if (progTombRev !== null && shadowRev !== null && shadowRev <= progTombRev) {
        continue;
      }

      const chapterId = asNonEmptyString(payload.chapterId);
      if (!chapterId) continue;

      const updatedAt = resolveTimestampIso(payload, shadow.updatedAt);
      const deviceTimestamp =
        typeof payload.deviceTimestamp === 'number' && Number.isFinite(payload.deviceTimestamp)
          ? payload.deviceTimestamp
          : shadow.updatedAt || parseIsoMs(updatedAt);

      const hasPresentation = Boolean(
        asNonEmptyString(storiesCatalog[storyId]?.title) && chaptersCatalog[chapterId],
      );

      progressMap.set(storyId, {
        ownerScope,
        storyId,
        chapterId,
        chapterVersionId: asNonEmptyString(payload.chapterVersionId) ?? null,
        readingMode: asNonEmptyString(payload.readingMode) ?? ReadingMode.WEBTOON,
        progressPercentage: clampPercentage(payload.progressPercentage),
        scrollPosition: Number(payload.scrollPosition) || 0,
        pageIndex: Math.max(1, Number(payload.pageIndex) || 1),
        anchorBlockId: asNonEmptyString(payload.anchorBlockId) ?? null,
        textOffset: typeof payload.textOffset === 'number' ? payload.textOffset : null,
        updatedAt,
        deviceTimestamp,
        source: 'SHADOW',
        serverRevision: shadow.serverRevision,
        epoch: shadowEpoch,
        needsHydration: !hasPresentation,
      });
    } else if (shadow.domain === SyncDomain.HISTORY) {
      if (isGlobalHistorySentinel(shadow.entityKey)) continue;
      const { storyId, chapterId } = extractHistoryStoryAndChapter(shadow.entityKey, payload);
      if (!storyId || !chapterId) continue;

      const chapterKey = `${storyId}:${chapterId}`;
      const effEpoch = getEffectiveHistoryEpoch(effectiveEpochs, storyId);
      const shadowEpoch = toNonNegativeInteger(shadow.epoch);
      if (shadowEpoch < effEpoch) {
        continue;
      }
      const histTombRev = getHistoryTombstoneRevision(tombstones, storyId, chapterKey);
      if (histTombRev !== null && shadowRev !== null && shadowRev <= histTombRev) {
        continue;
      }

      const catStory = storiesCatalog[storyId];
      const catChap = chaptersCatalog[chapterId];
      const storyTitle =
        asNonEmptyString(payload.storyTitle) ?? asNonEmptyString(catStory?.title) ?? '';
      const chapterNumber =
        typeof payload.chapterNumber === 'string' || typeof payload.chapterNumber === 'number'
          ? payload.chapterNumber
          : (catChap?.chapterNumber ?? '');
      const chapterTitle =
        asNonEmptyString(payload.chapterTitle) ?? asNonEmptyString(catChap?.chapterTitle);

      historyMap.set(chapterKey, {
        ownerScope,
        storyId,
        chapterId,
        chapterVersionId: asNonEmptyString(payload.chapterVersionId) ?? null,
        storyTitle,
        storySlug: asNonEmptyString(payload.storySlug) ?? asNonEmptyString(catStory?.slug),
        storyCoverUrl:
          asNonEmptyString(payload.storyCoverUrl) ?? asNonEmptyString(catStory?.coverUrl),
        chapterNumber,
        chapterTitle,
        progressPercentage: clampPercentage(payload.progressPercentage),
        lastReadAt: resolveTimestampIso(payload, shadow.updatedAt),
        source: 'SHADOW',
        serverRevision: shadow.serverRevision,
        epoch: shadowEpoch,
        needsHydration: storyTitle.length === 0,
      });
    } else if (shadow.domain === SyncDomain.PREFERENCE) {
      const key = getCanonicalEntityKey(SyncDomain.PREFERENCE, shadow.entityKey, payload);
      const tombRev = tombstones[SyncDomain.PREFERENCE].get(key) ?? null;
      if (tombRev !== null && shadowRev !== null && shadowRev <= tombRev) {
        continue;
      }

      preferenceMap.set(key, {
        ownerScope,
        key,
        value: payload.value,
        updatedAt: resolveTimestampIso(payload, shadow.updatedAt),
        source: 'SHADOW',
        serverRevision: shadow.serverRevision,
      });
    }
  }

  // Sort pending mutations deterministically by scope & timestamp
  const scopedPending = input.pendingMutations
    .filter((m) => m && m.ownerScope === ownerScope)
    .sort(compareMutationsChronologically);
  const pendingMutationIds = new Set(scopedPending.map((m) => m.mutationId));

  // Filter bounded post-receipt grace entries (TTL & synced revision retirement).
  // Fail-closed (P2-01): without a finite caller-supplied nowMs, grace entries are retired instead of lingering at 0ms.
  const activeGraceEntries = hasExplicitNowMs
    ? (input.graceEntries ?? [])
        .filter((g) => {
          if (!g || g.ownerScope !== ownerScope || !g.mutation) return false;
          if (pendingMutationIds.has(g.mutation.mutationId)) return false;
          if (!Number.isFinite(g.expiresAtMs) || nowMs >= g.expiresAtMs) return false;
          const assignedRev = parseRevisionBigInt(g.assignedRevision);
          if (assignedRev !== null && syncedRevBigInt >= assignedRev) return false;
          return true;
        })
        .sort((a, b) => compareMutationsChronologically(a.mutation, b.mutation))
    : [];

  let suppressedMutationCount = 0;
  let activeGraceAppliedCount = 0;

  const protectedBookmarkKeys = new Set<string>();
  const protectedProgressKeys = new Set<string>();
  const protectedHistoryKeys = new Set<string>();
  const protectedPreferenceKeys = new Set<string>();

  const applyMutationLayer = (
    mutation: LocalPendingMutation,
    source: 'GRACE' | 'PENDING',
  ): { applied: boolean } => {
    const payload = (mutation.payload ?? {}) as Record<string, unknown>;
    const baseRev = parseRevisionBigInt(mutation.baseServerRevision);

    if (mutation.domain === SyncDomain.BOOKMARK) {
      const storyId = getCanonicalEntityKey(SyncDomain.BOOKMARK, mutation.entityId, payload);
      if (mutation.operation === SyncOperation.DELETE) {
        bookmarkMap.delete(storyId);
        if (source === 'PENDING') protectedBookmarkKeys.add(storyId);
        return { applied: true };
      }
      if (mutation.operation === SyncOperation.UPSERT) {
        const tombRev = tombstones[SyncDomain.BOOKMARK].get(storyId) ?? null;
        if (tombRev !== null && baseRev !== null && baseRev < tombRev) {
          if (source === 'PENDING') suppressedMutationCount += 1;
          return { applied: false };
        }
        const existing = bookmarkMap.get(storyId);
        const catStory = storiesCatalog[storyId];
        const title =
          asNonEmptyString(payload.title) ??
          existing?.title ??
          asNonEmptyString(catStory?.title) ??
          '';
        bookmarkMap.set(storyId, {
          ownerScope,
          storyId,
          title,
          slug:
            asNonEmptyString(payload.slug) ??
            existing?.slug ??
            asNonEmptyString(catStory?.slug),
          coverUrl:
            asNonEmptyString(payload.coverUrl) ??
            existing?.coverUrl ??
            asNonEmptyString(catStory?.coverUrl),
          createdAt: resolveTimestampIso(payload, mutation.createdAt),
          source,
          needsHydration: title.length === 0,
        });
        if (source === 'PENDING') protectedBookmarkKeys.add(storyId);
        return { applied: true };
      }
      return { applied: false };
    }

    if (mutation.domain === SyncDomain.PREFERENCE) {
      const key = getCanonicalEntityKey(SyncDomain.PREFERENCE, mutation.entityId, payload);
      if (mutation.operation === SyncOperation.DELETE) {
        preferenceMap.delete(key);
        if (source === 'PENDING') protectedPreferenceKeys.add(key);
        return { applied: true };
      }
      if (mutation.operation === SyncOperation.UPSERT) {
        const tombRev = tombstones[SyncDomain.PREFERENCE].get(key) ?? null;
        if (tombRev !== null && baseRev !== null && baseRev < tombRev) {
          if (source === 'PENDING') suppressedMutationCount += 1;
          return { applied: false };
        }
        preferenceMap.set(key, {
          ownerScope,
          key,
          value: payload.value,
          updatedAt: resolveTimestampIso(payload, mutation.createdAt),
          source,
        });
        if (source === 'PENDING') protectedPreferenceKeys.add(key);
        return { applied: true };
      }
      return { applied: false };
    }

    if (mutation.domain === SyncDomain.HISTORY) {
      if (mutation.operation === SyncOperation.DELETE) {
        if (isGlobalHistorySentinel(mutation.entityId)) {
          historyMap.clear();
          progressMap.clear();
          if (source === 'PENDING') {
            protectedHistoryKeys.clear();
            protectedProgressKeys.clear();
          }
          return { applied: true };
        }

        const explicitChapterId = asNonEmptyString(payload.chapterId);
        const colonIdx = mutation.entityId.indexOf(':');
        if (explicitChapterId || colonIdx > 0) {
          const { storyId, chapterId } = extractHistoryStoryAndChapter(mutation.entityId, payload);
          if (storyId && chapterId) {
            const chapterKey = `${storyId}:${chapterId}`;
            historyMap.delete(chapterKey);
            if (source === 'PENDING') protectedHistoryKeys.add(chapterKey);
            return { applied: true };
          }
        }

        const storyId = getCanonicalEntityKey(SyncDomain.HISTORY, mutation.entityId, payload);
        for (const [k, item] of historyMap.entries()) {
          if (item.storyId === storyId) {
            historyMap.delete(k);
            if (source === 'PENDING') {
              protectedHistoryKeys.delete(k);
            }
          }
        }
        progressMap.delete(storyId);
        if (source === 'PENDING') {
          protectedProgressKeys.delete(storyId);
        }
        return { applied: true };
      }

      if (mutation.operation === SyncOperation.UPSERT) {
        const { storyId, chapterId } = extractHistoryStoryAndChapter(mutation.entityId, payload);
        if (!storyId || !chapterId) {
          if (source === 'PENDING') suppressedMutationCount += 1;
          return { applied: false };
        }
        const chapterKey = `${storyId}:${chapterId}`;
        const effEpoch = getEffectiveHistoryEpoch(effectiveEpochs, storyId);
        const histTombRev = getHistoryTombstoneRevision(tombstones, storyId, chapterKey);

        if (histTombRev !== null && baseRev !== null && baseRev < histTombRev) {
          if (source === 'PENDING') suppressedMutationCount += 1;
          return { applied: false };
        }

        const rawObsEpoch = payload.observedHistoryEpoch;
        let acceptedEpoch = effEpoch;
        if (rawObsEpoch !== undefined && rawObsEpoch !== null) {
          if (typeof rawObsEpoch !== 'number' || !Number.isInteger(rawObsEpoch) || rawObsEpoch < effEpoch) {
            if (source === 'PENDING') suppressedMutationCount += 1;
            return { applied: false };
          }
          acceptedEpoch = rawObsEpoch;
        } else if (effEpoch > 0) {
          if (source === 'PENDING') suppressedMutationCount += 1;
          return { applied: false };
        }

        const existing = historyMap.get(chapterKey);
        const incomingPct = clampPercentage(payload.progressPercentage);
        const mergedPct = Math.max(
          existing?.progressPercentage ?? 0,
          incomingPct,
        );
        const resultingSource: ProjectionSource =
          existing && mergedPct === existing.progressPercentage && mergedPct > incomingPct
            ? existing.source
            : source;
        const incomingLastRead = resolveTimestampIso(payload, mutation.createdAt);
        const mergedLastRead = pickLatestIso(existing?.lastReadAt, incomingLastRead);

        const catStory = storiesCatalog[storyId];
        const catChap = chaptersCatalog[chapterId];
        const storyTitle =
          asNonEmptyString(payload.storyTitle) ??
          existing?.storyTitle ??
          asNonEmptyString(catStory?.title) ??
          '';
        const chapterNumber =
          typeof payload.chapterNumber === 'string' || typeof payload.chapterNumber === 'number'
            ? payload.chapterNumber
            : (existing?.chapterNumber ?? catChap?.chapterNumber ?? '');
        const chapterTitle =
          asNonEmptyString(payload.chapterTitle) ??
          existing?.chapterTitle ??
          asNonEmptyString(catChap?.chapterTitle);

        historyMap.set(chapterKey, {
          ownerScope,
          storyId,
          chapterId,
          chapterVersionId:
            asNonEmptyString(payload.chapterVersionId) ?? existing?.chapterVersionId ?? null,
          storyTitle,
          storySlug:
            asNonEmptyString(payload.storySlug) ??
            existing?.storySlug ??
            asNonEmptyString(catStory?.slug),
          storyCoverUrl:
            asNonEmptyString(payload.storyCoverUrl) ??
            existing?.storyCoverUrl ??
            asNonEmptyString(catStory?.coverUrl),
          chapterNumber,
          chapterTitle,
          progressPercentage: mergedPct,
          lastReadAt: mergedLastRead,
          source: resultingSource,
          serverRevision: existing?.serverRevision,
          epoch: acceptedEpoch,
          needsHydration: storyTitle.length === 0,
        });

        if (resultingSource === 'PENDING') {
          protectedHistoryKeys.add(chapterKey);
        }
        return { applied: true };
      }

      return { applied: false };
    }

    if (mutation.domain === SyncDomain.PROGRESS) {
      const storyId = getCanonicalEntityKey(SyncDomain.PROGRESS, mutation.entityId, payload);

      if (mutation.operation === SyncOperation.DELETE) {
        progressMap.delete(storyId);
        if (source === 'PENDING') protectedProgressKeys.add(storyId);
        return { applied: true };
      }

      if (mutation.operation === SyncOperation.UPSERT) {
        const effEpoch = getEffectiveHistoryEpoch(effectiveEpochs, storyId);
        const rawObsEpoch = payload.observedHistoryEpoch;
        if (rawObsEpoch !== undefined && rawObsEpoch !== null) {
          if (typeof rawObsEpoch !== 'number' || !Number.isInteger(rawObsEpoch) || rawObsEpoch < effEpoch) {
            if (source === 'PENDING') suppressedMutationCount += 1;
            return { applied: false };
          }
        }

        const progTombRev = getProgressTombstoneRevision(tombstones, storyId);
        if (progTombRev !== null && baseRev !== null && baseRev < progTombRev) {
          if (source === 'PENDING') suppressedMutationCount += 1;
          return { applied: false };
        }

        const existing = progressMap.get(storyId);
        const chapterId = asNonEmptyString(payload.chapterId) ?? existing?.chapterId;
        if (!chapterId) {
          if (source === 'PENDING') suppressedMutationCount += 1;
          return { applied: false };
        }

        const incomingPct = clampPercentage(payload.progressPercentage);
        const forceRewind = Boolean(payload.forceRewind);
        const preserveExistingSameChapter = Boolean(
          existing &&
            existing.chapterId === chapterId &&
            !forceRewind &&
            incomingPct < existing.progressPercentage,
        );

        const updatedAt = resolveTimestampIso(payload, mutation.createdAt);
        const deviceTimestamp =
          typeof payload.deviceTimestamp === 'number' && Number.isFinite(payload.deviceTimestamp)
            ? payload.deviceTimestamp
            : parseIsoMs(updatedAt);
        const resolvedEpoch =
          typeof rawObsEpoch === 'number' && Number.isInteger(rawObsEpoch)
            ? rawObsEpoch
            : effEpoch;

        if (!preserveExistingSameChapter) {
          const hasPresentation = Boolean(
            asNonEmptyString(storiesCatalog[storyId]?.title) && chaptersCatalog[chapterId],
          );
          progressMap.set(storyId, {
            ownerScope,
            storyId,
            chapterId,
            chapterVersionId:
              asNonEmptyString(payload.chapterVersionId) ??
              (existing?.chapterId === chapterId ? existing.chapterVersionId : null) ??
              null,
            readingMode:
              asNonEmptyString(payload.readingMode) ??
              existing?.readingMode ??
              ReadingMode.WEBTOON,
            progressPercentage: incomingPct,
            scrollPosition: Number(payload.scrollPosition) || 0,
            pageIndex: Math.max(1, Number(payload.pageIndex) || 1),
            anchorBlockId: asNonEmptyString(payload.anchorBlockId) ?? null,
            textOffset: typeof payload.textOffset === 'number' ? payload.textOffset : null,
            updatedAt,
            deviceTimestamp,
            source,
            epoch: resolvedEpoch,
            needsHydration: !hasPresentation,
          });
        }

        if (progressMap.get(storyId)?.source === 'PENDING') {
          protectedProgressKeys.add(storyId);
        }

        // Monotonically mirror unsuppressed PROGRESS UPSERT to projected HISTORY only when HISTORY epoch proof holds
        const chapterKey = `${storyId}:${chapterId}`;
        const histTombRev = getHistoryTombstoneRevision(tombstones, storyId, chapterKey);
        const canMirrorToHistory =
          (histTombRev === null || baseRev === null || baseRev >= histTombRev) &&
          (rawObsEpoch !== undefined && rawObsEpoch !== null
            ? typeof rawObsEpoch === 'number' && Number.isInteger(rawObsEpoch) && rawObsEpoch >= effEpoch
            : effEpoch === 0);

        if (canMirrorToHistory) {
          const existingHist = historyMap.get(chapterKey);
          const mergedPct = Math.max(existingHist?.progressPercentage ?? 0, incomingPct);
          const resultingMirrorSource: ProjectionSource =
            existingHist && mergedPct === existingHist.progressPercentage && mergedPct > incomingPct
              ? existingHist.source
              : source;
          const catStory = storiesCatalog[storyId];
          const catChap = chaptersCatalog[chapterId];
          const storyTitle =
            asNonEmptyString(payload.storyTitle) ??
            existingHist?.storyTitle ??
            asNonEmptyString(catStory?.title) ??
            '';
          const chapterNumber =
            typeof payload.chapterNumber === 'string' || typeof payload.chapterNumber === 'number'
              ? payload.chapterNumber
              : (existingHist?.chapterNumber ?? catChap?.chapterNumber ?? '');
          const chapterTitle =
            asNonEmptyString(payload.chapterTitle) ??
            existingHist?.chapterTitle ??
            asNonEmptyString(catChap?.chapterTitle);

          historyMap.set(chapterKey, {
            ownerScope,
            storyId,
            chapterId,
            chapterVersionId:
              asNonEmptyString(payload.chapterVersionId) ??
              existingHist?.chapterVersionId ??
              null,
            storyTitle,
            storySlug:
              asNonEmptyString(payload.storySlug) ??
              existingHist?.storySlug ??
              asNonEmptyString(catStory?.slug),
            storyCoverUrl:
              asNonEmptyString(payload.storyCoverUrl) ??
              existingHist?.storyCoverUrl ??
              asNonEmptyString(catStory?.coverUrl),
            chapterNumber,
            chapterTitle,
            progressPercentage: mergedPct,
            lastReadAt: pickLatestIso(existingHist?.lastReadAt, updatedAt),
            source: resultingMirrorSource,
            serverRevision: existingHist?.serverRevision,
            epoch: resolvedEpoch,
            needsHydration: storyTitle.length === 0,
          });

          if (resultingMirrorSource === 'PENDING') {
            protectedHistoryKeys.add(chapterKey);
          }
        }

        return { applied: true };
      }
    }

    return { applied: false };
  };

  // Step 2: Fold bounded in-session grace entries (only if active before Delta Pull catches up)
  for (const grace of activeGraceEntries) {
    const res = applyMutationLayer(grace.mutation, 'GRACE');
    if (res.applied) {
      activeGraceAppliedCount += 1;
    }
  }

  // Step 3: Fold committed durable pending mutations chronologically
  for (const mutation of scopedPending) {
    applyMutationLayer(mutation, 'PENDING');
  }

  // Deterministic output sorting
  const bookmarks = Array.from(bookmarkMap.values()).sort((a, b) => {
    const diff = parseIsoMs(b.createdAt) - parseIsoMs(a.createdAt);
    if (diff !== 0) return diff;
    return a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0;
  });

  const progress = Array.from(progressMap.values()).sort((a, b) => {
    const diff = parseIsoMs(b.updatedAt) - parseIsoMs(a.updatedAt);
    if (diff !== 0) return diff;
    return a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0;
  });

  const history = Array.from(historyMap.values()).sort((a, b) => {
    const diff = parseIsoMs(b.lastReadAt) - parseIsoMs(a.lastReadAt);
    if (diff !== 0) return diff;
    if (a.storyId !== b.storyId) return a.storyId < b.storyId ? -1 : 1;
    return a.chapterId < b.chapterId ? -1 : a.chapterId > b.chapterId ? 1 : 0;
  });

  const preferences = Array.from(preferenceMap.values()).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  return {
    ownerScope,
    syncedServerRevision,
    effectiveHistoryEpochs: effectiveEpochs,
    bookmarks,
    progress,
    history,
    preferences,
    suppressedMutationCount,
    activeGraceCount: activeGraceAppliedCount,
    pendingMutationCount: scopedPending.length,
    protectedPending: {
      BOOKMARK: Array.from(protectedBookmarkKeys).sort(),
      PROGRESS: Array.from(protectedProgressKeys).sort(),
      HISTORY: Array.from(protectedHistoryKeys).sort(),
      PREFERENCE: Array.from(protectedPreferenceKeys).sort(),
    },
  };
}
