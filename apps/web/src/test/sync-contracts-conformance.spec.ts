import { describe, it, expect } from 'vitest';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  ClientMutation,
  MutationResultItem,
  PushMutationsBatchResponse,
  SyncChangesResponse,
  SyncSnapshotResponse,
  SnapshotHistoryEpochItem,
  SnapshotTombstoneItem,
  SixDomainSnapshotData,
  SixDomainSyncSnapshotResponse,
  SnapshotPartitionDomain,
  GLOBAL_HISTORY_EPOCH_SENTINEL,
  SNAPSHOT_PARTITION_DOMAINS,
  SYNC_TOMBSTONE_DOMAINS,
  isValidTombstoneDomain,
  isSixDomainSnapshotData,
  isSixDomainSyncSnapshotResponse,
  BookmarkMutationPayload,
  ProgressMutationPayload,
  HistoryMutationPayload,
  PreferenceMutationPayload,
} from '@omninovel/shared';

describe('Task 7C.3 — Shared Canonical Sync Contracts Conformance', () => {
  it('should export all 5 canonical SyncDomain values', () => {
    expect(SyncDomain.BOOKMARK).toBe('BOOKMARK');
    expect(SyncDomain.PROGRESS).toBe('PROGRESS');
    expect(SyncDomain.HISTORY).toBe('HISTORY');
    expect(SyncDomain.PREFERENCE).toBe('PREFERENCE');
    expect(SyncDomain.FOLLOW).toBe('FOLLOW');
  });

  it('should export canonical SyncOperation values', () => {
    expect(SyncOperation.UPSERT).toBe('UPSERT');
    expect(SyncOperation.DELETE).toBe('DELETE');
  });

  it('should reuse ReadingMode without duplicate enum collision', () => {
    expect(ReadingMode.WEBTOON).toBe('WEBTOON');
    expect(ReadingMode.PAGED).toBe('PAGED');
    expect(ReadingMode.NOVEL).toBe('NOVEL');
  });

  it('should conform to ClientMutation structure with decimal string baseServerRevision', () => {
    const mutation: ClientMutation = {
      clientId: '550e8400-e29b-41d4-a716-446655440000',
      mutationId: '550e8400-e29b-41d4-a716-446655440001',
      domain: SyncDomain.PROGRESS,
      entityId: '550e8400-e29b-41d4-a716-446655440002',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '9223372036854775807', // 64-bit BigInt Decimal String
      payload: {
        storyId: '550e8400-e29b-41d4-a716-446655440002',
        chapterId: '550e8400-e29b-41d4-a716-446655440003',
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 120.5,
        progressPercentage: 45,
        observedHistoryEpoch: 1,
      } satisfies ProgressMutationPayload,
      clientCreatedAt: '2026-10-28T22:00:00.000Z',
    };

    expect(mutation.domain).toBe(SyncDomain.PROGRESS);
    expect(BigInt(mutation.baseServerRevision)).toBe(9223372036854775807n);
  });

  it('should support MutationResultItem with assignedRevision string | null and DOMAIN_NOT_SUPPORTED', () => {
    const appliedResult: MutationResultItem = {
      mutationId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'APPLIED',
      assignedRevision: '105',
    };

    const notSupportedResult: MutationResultItem = {
      mutationId: '550e8400-e29b-41d4-a716-446655440002',
      status: 'DOMAIN_NOT_SUPPORTED',
      assignedRevision: null,
      reason: 'FOLLOW domain is not yet supported in Phase 7C',
    };

    const batchResponse: PushMutationsBatchResponse = {
      processedCount: 2,
      newServerRevision: '105',
      results: [appliedResult, notSupportedResult],
    };

    expect(batchResponse.results[0].status).toBe('APPLIED');
    expect(batchResponse.results[1].status).toBe('DOMAIN_NOT_SUPPORTED');
    expect(batchResponse.results[1].assignedRevision).toBeNull();
  });

  it('should accurately handle SyncChangesResponse with nextRevision and minActiveRevision', () => {
    const changesResponse: SyncChangesResponse = {
      currentServerRevision: '200',
      minActiveRevision: '50',
      nextRevision: '100',
      hasMore: true,
      changes: [
        {
          revision: '51',
          domain: SyncDomain.BOOKMARK,
          entityId: '550e8400-e29b-41d4-a716-446655440010',
          operation: SyncOperation.UPSERT,
          payload: { storyId: '550e8400-e29b-41d4-a716-446655440010' } satisfies BookmarkMutationPayload,
          createdAt: '2026-10-28T22:00:00.000Z',
        },
      ],
    };

    expect(changesResponse.hasMore).toBe(true);
    expect(changesResponse.nextRevision).toBe('100');
    // Paginated checkpoint invariant: when hasMore === true, Web Client MUST checkpoint to nextRevision
    const targetCheckpoint = changesResponse.hasMore && changesResponse.nextRevision
      ? changesResponse.nextRevision
      : changesResponse.currentServerRevision;
    expect(targetCheckpoint).toBe('100');
  });

  it('should support SnapshotData with chapterReadStates mapping and preferences', () => {
    const snapshot: SyncSnapshotResponse = {
      snapshotRevision: '500',
      minActiveRevision: '500',
      hasMore: false,
      nextCursor: null,
      data: {
        bookmarks: [
          {
            storyId: '550e8400-e29b-41d4-a716-446655440010',
            createdAt: '2026-10-28T21:00:00.000Z',
          },
        ],
        readingProgress: [
          {
            storyId: '550e8400-e29b-41d4-a716-446655440010',
            chapterId: '550e8400-e29b-41d4-a716-446655440011',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 12,
            scrollPosition: 540,
            progressPercentage: 60,
          },
        ],
        chapterReadStates: [
          {
            storyId: '550e8400-e29b-41d4-a716-446655440010',
            chapterId: '550e8400-e29b-41d4-a716-446655440011',
            chapterVersionId: null,
            maxProgressPercentage: 60,
            completedAt: null,
            lastReadAt: '2026-10-28T21:30:00.000Z',
            storyHistoryEpoch: 0,
          },
        ],
        preferences: [
          {
            key: 'theme',
            value: 'dark',
            updatedAt: '2026-10-28T21:00:00.000Z',
          },
        ],
      },
    };

    expect(snapshot.data.chapterReadStates[0].maxProgressPercentage).toBe(60);
    expect(snapshot.data.preferences[0].value).toBe('dark');
  });

  it('should safely compare large 64-bit decimal string revisions using BigInt', () => {
    const revA = '10000000000000000001';
    const revB = '10000000000000000002';
    // JavaScript Number loses precision: Number(revA) === Number(revB) is TRUE!
    expect(Number(revA) === Number(revB)).toBe(true); // Precision lost in float64
    // BigInt retains exact precision:
    expect(BigInt(revA) < BigInt(revB)).toBe(true);
    expect(BigInt(revA) === BigInt(revB)).toBe(false);
  });
});

describe('Patch Set A — Six-Domain Shared Snapshot Contracts Conformance', () => {
  const buildValidSixDomainSnapshot = (): SixDomainSyncSnapshotResponse => {
    const historyEpochs: SnapshotHistoryEpochItem[] = [
      { storyId: '550e8400-e29b-41d4-a716-446655440010', epoch: 1 },
      { storyId: '550e8400-e29b-41d4-a716-446655440020', epoch: 4 },
    ];
    const tombstones: SnapshotTombstoneItem[] = [
      {
        domain: SyncDomain.HISTORY,
        entityId: GLOBAL_HISTORY_EPOCH_SENTINEL,
        deletedAtRevision: '11',
      },
      {
        domain: SyncDomain.PREFERENCE,
        entityId: 'pref:a:b',
        deletedAtRevision: '12',
      },
      {
        domain: SyncDomain.BOOKMARK,
        entityId: '550e8400-e29b-41d4-a716-446655440030',
        deletedAtRevision: '15',
      },
    ];
    const data: SixDomainSnapshotData = {
      bookmarks: [],
      readingProgress: [],
      chapterReadStates: [],
      preferences: [{ key: 'theme:colon', value: 'dark', updatedAt: '2026-11-09T10:00:00.000Z' }],
      historyEpochs,
      tombstones,
    };

    return {
      snapshotRevision: '15',
      minActiveRevision: '1',
      globalHistoryEpoch: 3,
      hasMore: false,
      nextCursor: null,
      data,
    };
  };

  it('should export canonical partition domains, sentinel UUID, and tombstone domain helpers', () => {
    const domains: readonly SnapshotPartitionDomain[] = SNAPSHOT_PARTITION_DOMAINS;
    expect(domains).toEqual([
      'BOOKMARK',
      'PROGRESS',
      'CHAPTER_READ_STATE',
      'PREFERENCE',
      'HISTORY_TOMBSTONE',
      'SYNC_TOMBSTONE',
    ]);
    expect(GLOBAL_HISTORY_EPOCH_SENTINEL).toBe('00000000-0000-0000-0000-000000000000');
    expect(SYNC_TOMBSTONE_DOMAINS).toEqual([
      SyncDomain.BOOKMARK,
      SyncDomain.PROGRESS,
      SyncDomain.HISTORY,
      SyncDomain.PREFERENCE,
    ]);
    expect(isValidTombstoneDomain(SyncDomain.BOOKMARK)).toBe(true);
    expect(isValidTombstoneDomain(SyncDomain.PROGRESS)).toBe(true);
    expect(isValidTombstoneDomain(SyncDomain.HISTORY)).toBe(true);
    expect(isValidTombstoneDomain(SyncDomain.PREFERENCE)).toBe(true);
    expect(isValidTombstoneDomain(SyncDomain.FOLLOW)).toBe(false);
    expect(isValidTombstoneDomain('UNKNOWN')).toBe(false);
  });

  it('should validate valid six-domain snapshots including 64-bit BIGINT revisions and paginated cursors', () => {
    const sixDomain = buildValidSixDomainSnapshot();
    // Backward-compatible structural subtype check
    const wideContract: SyncSnapshotResponse = sixDomain;

    expect(wideContract.globalHistoryEpoch).toBe(3);
    expect(isSixDomainSnapshotData(sixDomain.data)).toBe(true);
    expect(isSixDomainSyncSnapshotResponse(sixDomain)).toBe(true);

    const paginatedMaxBigInt: SixDomainSyncSnapshotResponse = {
      ...sixDomain,
      snapshotRevision: '9223372036854775807',
      minActiveRevision: '1',
      hasMore: true,
      nextCursor: 'v1.signed-hmac-cursor',
    };
    expect(isSixDomainSyncSnapshotResponse(paginatedMaxBigInt)).toBe(true);
  });

  it('should maintain backward compatibility with unmodified 4-domain Web and Core API snapshot DTO shapes', () => {
    const legacy4DomainResponse: SyncSnapshotResponse = {
      snapshotRevision: '42',
      minActiveRevision: '0',
      hasMore: false,
      nextCursor: null,
      data: {
        bookmarks: [],
        readingProgress: [],
        chapterReadStates: [],
        preferences: [],
      },
    };

    expect(legacy4DomainResponse.globalHistoryEpoch).toBeUndefined();
    expect(legacy4DomainResponse.data.historyEpochs).toBeUndefined();
    expect(legacy4DomainResponse.data.tombstones).toBeUndefined();
    expect(isSixDomainSnapshotData(legacy4DomainResponse.data)).toBe(false);
    expect(isSixDomainSyncSnapshotResponse(legacy4DomainResponse)).toBe(false);
  });

  it('should reject duplicated sentinel in historyEpochs, legacy HISTORY:all, and FOLLOW tombstones', () => {
    const duplicateSentinel = buildValidSixDomainSnapshot();
    duplicateSentinel.data.historyEpochs.push({
      storyId: GLOBAL_HISTORY_EPOCH_SENTINEL,
      epoch: 3,
    });
    expect(isSixDomainSnapshotData(duplicateSentinel.data)).toBe(false);
    expect(isSixDomainSyncSnapshotResponse(duplicateSentinel)).toBe(false);

    const legacyAllTombstone = buildValidSixDomainSnapshot();
    legacyAllTombstone.data.tombstones.push({
      domain: SyncDomain.HISTORY,
      entityId: 'all',
      deletedAtRevision: '11',
    });
    expect(isSixDomainSnapshotData(legacyAllTombstone.data)).toBe(false);
    expect(isSixDomainSyncSnapshotResponse(legacyAllTombstone)).toBe(false);

    const unsupportedFollowTombstone = buildValidSixDomainSnapshot();
    unsupportedFollowTombstone.data.tombstones.push({
      domain: SyncDomain.FOLLOW as unknown as SnapshotTombstoneItem['domain'],
      entityId: '550e8400-e29b-41d4-a716-446655440099',
      deletedAtRevision: '12',
    });
    expect(isSixDomainSnapshotData(unsupportedFollowTombstone.data)).toBe(false);
    expect(isSixDomainSyncSnapshotResponse(unsupportedFollowTombstone)).toBe(false);
  });

  it('should fail-closed on malformed epochs, overflow/non-decimal revisions, and inconsistent envelope bounds', () => {
    const negativeGlobalEpoch = { ...buildValidSixDomainSnapshot(), globalHistoryEpoch: -1 };
    expect(isSixDomainSyncSnapshotResponse(negativeGlobalEpoch)).toBe(false);

    const floatStoryEpoch = buildValidSixDomainSnapshot();
    floatStoryEpoch.data.historyEpochs[0].epoch = 1.5;
    expect(isSixDomainSnapshotData(floatStoryEpoch.data)).toBe(false);

    const overflowTombstoneRev = buildValidSixDomainSnapshot();
    overflowTombstoneRev.data.tombstones[0].deletedAtRevision = '9223372036854775808';
    expect(isSixDomainSnapshotData(overflowTombstoneRev.data)).toBe(false);

    const staleTombstone = buildValidSixDomainSnapshot();
    staleTombstone.minActiveRevision = '12'; // tombstone rev '11' < minActiveRevision '12'
    expect(isSixDomainSyncSnapshotResponse(staleTombstone)).toBe(false);

    const aheadTombstone = buildValidSixDomainSnapshot();
    aheadTombstone.snapshotRevision = '14'; // tombstone rev '15' > snapshotRevision '14'
    expect(isSixDomainSyncSnapshotResponse(aheadTombstone)).toBe(false);

    const invertedWindow = { ...buildValidSixDomainSnapshot(), minActiveRevision: '16', snapshotRevision: '15' };
    expect(isSixDomainSyncSnapshotResponse(invertedWindow)).toBe(false);

    const paddedStoryId = buildValidSixDomainSnapshot();
    paddedStoryId.data.historyEpochs[0].storyId = ' story-with-padding ';
    expect(isSixDomainSnapshotData(paddedStoryId.data)).toBe(false);

    for (const badRev of ['-1', 'abc', '1.5', ' 11', '']) {
      const badTombstoneRev = buildValidSixDomainSnapshot();
      badTombstoneRev.data.tombstones[0].deletedAtRevision = badRev;
      expect(isSixDomainSnapshotData(badTombstoneRev.data)).toBe(false);
    }

    const emptyEntityId = buildValidSixDomainSnapshot();
    emptyEntityId.data.tombstones[0].entityId = '   ';
    expect(isSixDomainSnapshotData(emptyEntityId.data)).toBe(false);

    const missingCursorOnHasMore = { ...buildValidSixDomainSnapshot(), hasMore: true, nextCursor: null };
    expect(isSixDomainSyncSnapshotResponse(missingCursorOnHasMore)).toBe(false);

    const emptyCursorOnHasMore = { ...buildValidSixDomainSnapshot(), hasMore: true, nextCursor: '' };
    expect(isSixDomainSyncSnapshotResponse(emptyCursorOnHasMore)).toBe(false);

    const strayCursorOnLastPage = { ...buildValidSixDomainSnapshot(), hasMore: false, nextCursor: 'v1.unexpected' };
    expect(isSixDomainSyncSnapshotResponse(strayCursorOnLastPage)).toBe(false);
  });
});
