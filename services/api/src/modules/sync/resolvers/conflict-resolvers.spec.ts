import { BookmarkConflictResolver } from './bookmark.resolver';
import { ProgressConflictResolver } from './progress.resolver';
import { HistoryConflictResolver } from './history.resolver';
import { PreferenceConflictResolver } from './preference.resolver';
import { FollowConflictResolver } from './follow.resolver';
import { ConflictResolverDispatcher } from './conflict-resolver.dispatcher';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';
import { ClientMutationDto } from '../dto/client-mutation.dto';

describe('Sync Conflict Resolvers (Step 2)', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';

  function createMockMutation(overrides: Partial<ClientMutationDto> = {}): ClientMutationDto {
    return {
      clientId: '22222222-2222-4222-8222-222222222222',
      mutationId: '33333333-3333-4333-8333-333333333333',
      domain: SyncDomain.BOOKMARK,
      entityId: 'story-123',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '100',
      payload: {},
      ...overrides,
    };
  }

  describe('BookmarkConflictResolver', () => {
    let resolver: BookmarkConflictResolver;

    beforeEach(() => {
      resolver = new BookmarkConflictResolver();
    });

    it('should accept UPSERT when no tombstone exists', () => {
      const mutation = createMockMutation({ domain: SyncDomain.BOOKMARK });
      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '110',
        minActiveRevision: '50',
        tombstoneRevision: null,
      });

      expect(result.status).toBe('APPLIED');
    });

    it('should reject UPSERT with REJECTED_TOMBSTONE when tombstone revision >= baseServerRevision (Anti-Resurrection)', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.BOOKMARK,
        baseServerRevision: '100',
      });

      // Tombstone occurred at revision 105 (newer than client base 100)
      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '110',
        minActiveRevision: '50',
        tombstoneRevision: '105',
      });

      expect(result.status).toBe('REJECTED_TOMBSTONE');
      expect(result.reason).toBe('TOMBSTONE_CONFLICT');
    });

    it('should accept UPSERT when client base revision is newer than tombstone revision', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.BOOKMARK,
        baseServerRevision: '120',
      });

      // Tombstone was at rev 105, but client base is 120 (user re-bookmarked after deletion)
      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '130',
        minActiveRevision: '50',
        tombstoneRevision: '105',
      });

      expect(result.status).toBe('APPLIED');
    });

    it('should accept DELETE operation idempotently', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.BOOKMARK,
        operation: SyncOperation.DELETE,
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '110',
        minActiveRevision: '50',
      });

      expect(result.status).toBe('APPLIED');
    });
  });

  describe('ProgressConflictResolver', () => {
    let resolver: ProgressConflictResolver;

    beforeEach(() => {
      resolver = new ProgressConflictResolver();
    });

    it('should accept initial reading progress when no server record exists', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          progressPercentage: 50,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        existingRecord: null,
      });

      expect(result.status).toBe('APPLIED');
    });

    it('should accept forward progress when incoming percentage is greater', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          chapterVersionId: 'v1',
          progressPercentage: 80,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        existingRecord: {
          chapterId: 'chap-1',
          chapterVersionId: 'v1',
          progressPercentage: 60,
        },
      });

      expect(result.status).toBe('APPLIED');
    });

    it('should preserve higher server progress with CONFLICT_MERGED when rewinding without forceRewind (Monotonic Forward)', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          chapterVersionId: 'v1',
          progressPercentage: 40,
          forceRewind: false,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        existingRecord: {
          chapterId: 'chap-1',
          chapterVersionId: 'v1',
          progressPercentage: 75,
          pageIndex: 15,
          scrollPosition: 1200,
        },
      });

      expect(result.status).toBe('CONFLICT_MERGED');
      expect(result.reason).toBe('MONOTONIC_PROGRESS_PRESERVED');
      expect(result.resolvedPayload?.progressPercentage).toBe(75);
    });

    it('should allow rewinding to lower progress when forceRewind is true', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          chapterVersionId: 'v1',
          progressPercentage: 20,
          forceRewind: true,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        existingRecord: {
          chapterId: 'chap-1',
          chapterVersionId: 'v1',
          progressPercentage: 85,
        },
      });

      expect(result.status).toBe('APPLIED');
    });

    it('should preserve higher server progress when version layout mismatch has lower incoming progress without forceRewind', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          chapterVersionId: 'remaster-v2',
          pageIndex: 5,
          scrollPosition: 200,
          progressPercentage: 25,
          forceRewind: false,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        existingRecord: {
          chapterId: 'chap-1',
          chapterVersionId: 'scan-v1',
          readingMode: 'PAGED',
          pageIndex: 20,
          scrollPosition: 0,
          progressPercentage: 90,
        },
      });

      // Semantic safety: không so sánh pageIndex 5 vs 20 mù quáng,
      // đồng thời không vô tình giảm 90% xuống 25% khi client chưa có forceRewind
      expect(result.status).toBe('CONFLICT_MERGED');
      expect(result.reason).toBe('MONOTONIC_PROGRESS_PRESERVED');
      expect(result.resolvedPayload?.chapterVersionId).toBe('scan-v1');
      expect(result.resolvedPayload?.progressPercentage).toBe(90);
    });

    it('should advance to new version layout progress when incoming percentage is greater or equal', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          chapterVersionId: 'remaster-v2',
          pageIndex: 18,
          progressPercentage: 95,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        existingRecord: {
          chapterId: 'chap-1',
          chapterVersionId: 'scan-v1',
          pageIndex: 15,
          progressPercentage: 80,
        },
      });

      expect(result.status).toBe('APPLIED');
      expect(result.message).toContain('Version layout mismatch resolved by advancing to new version');
    });

    it('should allow version layout rewind when explicit forceRewind is true', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          chapterVersionId: 'remaster-v2',
          pageIndex: 2,
          progressPercentage: 10,
          forceRewind: true,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        existingRecord: {
          chapterId: 'chap-1',
          chapterVersionId: 'scan-v1',
          pageIndex: 20,
          progressPercentage: 90,
        },
      });

      expect(result.status).toBe('APPLIED');
      expect(result.message).toContain('forceRewind');
    });

    it('should reject UPSERT with REJECTED_TOMBSTONE when tombstone revision > baseServerRevision (Anti-Resurrection P0-07)', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          progressPercentage: 50,
        },
      });

      // Tombstone occurred at revision 105 (newer than client base 100)
      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '110',
        minActiveRevision: '50',
        tombstoneRevision: '105',
      });

      expect(result.status).toBe('REJECTED_TOMBSTONE');
      expect(result.reason).toBe('TOMBSTONE_CONFLICT');
      expect(result.message).toContain('deleted by a history clear operation');
    });

    it('should accept UPSERT when client base revision >= tombstone revision (Legitimate New Read after deletion)', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        baseServerRevision: '105',
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          progressPercentage: 50,
        },
      });

      // Tombstone was at rev 105, and client base is 105 (client observed the deletion and is reading again)
      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '110',
        minActiveRevision: '50',
        tombstoneRevision: '105',
      });

      expect(result.status).toBe('APPLIED');
    });

    it('should reject UPSERT with REJECTED_TOMBSTONE when observedHistoryEpoch < effectiveHistoryEpoch (P0-07)', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          progressPercentage: 50,
          observedHistoryEpoch: 0,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '110',
        minActiveRevision: '50',
        effectiveHistoryEpoch: 2,
      });

      expect(result.status).toBe('REJECTED_TOMBSTONE');
      expect(result.reason).toBe('STALE_HISTORY_EPOCH');
    });

    it('should accept UPSERT when observedHistoryEpoch >= effectiveHistoryEpoch', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PROGRESS,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          progressPercentage: 50,
          observedHistoryEpoch: 2,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '110',
        minActiveRevision: '50',
        effectiveHistoryEpoch: 2,
      });

      expect(result.status).toBe('APPLIED');
    });
  });

  describe('HistoryConflictResolver', () => {
    let resolver: HistoryConflictResolver;

    beforeEach(() => {
      resolver = new HistoryConflictResolver();
    });

    it('should accept history write when observedHistoryEpoch strictly equals effectiveHistoryEpoch', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.HISTORY,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          progressPercentage: 100,
          observedHistoryEpoch: 5,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        effectiveHistoryEpoch: 5,
      });

      expect(result.status).toBe('APPLIED');
    });

    it('should reject history write with REJECTED_TOMBSTONE when observedHistoryEpoch !== effectiveHistoryEpoch (Strict Equality)', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.HISTORY,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          progressPercentage: 100,
          observedHistoryEpoch: 4, // Stale epoch before history was cleared (effective is 5)
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        effectiveHistoryEpoch: 5,
      });

      expect(result.status).toBe('REJECTED_TOMBSTONE');
      expect(result.reason).toBe('STALE_HISTORY_EPOCH');
      expect(result.metadata?.observedEpoch).toBe(4);
      expect(result.metadata?.effectiveEpoch).toBe(5);
    });

    it('should reject history write when observedHistoryEpoch is missing or non-integer', () => {
      const missingEpochMutation = createMockMutation({
        domain: SyncDomain.HISTORY,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-1',
          progressPercentage: 100,
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation: missingEpochMutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        effectiveHistoryEpoch: 0,
      });

      expect(result.status).toBe('REJECTED_TOMBSTONE');
      expect(result.reason).toBe('STALE_HISTORY_EPOCH');
    });

    it('DT-19A: should accept HISTORY DELETE operation without requiring observedHistoryEpoch', () => {
      const deleteMutation = createMockMutation({
        domain: SyncDomain.HISTORY,
        operation: SyncOperation.DELETE,
        entityId: 'story-123',
        payload: {
          storyId: 'story-123',
        },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation: deleteMutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        effectiveHistoryEpoch: 5,
      });

      expect(result.status).toBe('APPLIED');
      expect(result.message).toContain('History deletion accepted');
    });

    it('DT-19A (Global): should accept global HISTORY DELETE with entityId "all" without observedHistoryEpoch', () => {
      const globalDeleteMutation = createMockMutation({
        domain: SyncDomain.HISTORY,
        operation: SyncOperation.DELETE,
        entityId: 'all',
        payload: {},
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation: globalDeleteMutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
        effectiveHistoryEpoch: 10,
      });

      expect(result.status).toBe('APPLIED');
    });
  });

  describe('PreferenceConflictResolver', () => {
    let resolver: PreferenceConflictResolver;

    beforeEach(() => {
      resolver = new PreferenceConflictResolver();
    });

    it('should accept whitelisted account-scoped preferences', () => {
      const validKeys = [
        'theme',
        'reader_theme',
        'font_family',
        'font_size_scale',
        'reading_mode_preference',
        'locale',
        'reading_direction',
        'auto_scroll_speed',
      ];

      for (const key of validKeys) {
        const mutation = createMockMutation({
          domain: SyncDomain.PREFERENCE,
          entityId: key,
          payload: { key, value: 'dark' },
        });

        const result = resolver.resolve({
          userId: USER_ID,
          mutation,
          canonicalHash: 'hash',
          serverRevision: '100',
          minActiveRevision: '50',
        });

        expect(result.status).toBe('APPLIED');
      }
    });

    it('should reject device-scoped preferences with DEVICE_PREFERENCE_NOT_SYNCABLE', () => {
      const deviceKeys = [
        'screen_brightness',
        'device_volume',
        'offline_storage_path',
        'device_id',
        'haptic_feedback_enabled',
        'push_token',
      ];

      for (const key of deviceKeys) {
        const mutation = createMockMutation({
          domain: SyncDomain.PREFERENCE,
          entityId: key,
          payload: { key, value: 80 },
        });

        const result = resolver.resolve({
          userId: USER_ID,
          mutation,
          canonicalHash: 'hash',
          serverRevision: '100',
          minActiveRevision: '50',
        });

        expect(result.status).toBe('REJECTED_STALE');
        expect(result.reason).toBe('DEVICE_PREFERENCE_NOT_SYNCABLE');
      }
    });

    it('should reject unknown preference keys with PREFERENCE_KEY_NOT_SUPPORTED', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.PREFERENCE,
        entityId: 'unsupported_random_config',
        payload: { key: 'unsupported_random_config', value: true },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
      });

      expect(result.status).toBe('REJECTED_STALE');
      expect(result.reason).toBe('PREFERENCE_KEY_NOT_SUPPORTED');
    });
  });

  describe('FollowConflictResolver', () => {
    let resolver: FollowConflictResolver;

    beforeEach(() => {
      resolver = new FollowConflictResolver();
    });

    it('should return DOMAIN_NOT_SUPPORTED for any FOLLOW mutation and NEVER return REJECTED_STALE', () => {
      const mutation = createMockMutation({
        domain: SyncDomain.FOLLOW,
        entityId: 'story-123',
        operation: SyncOperation.UPSERT,
        payload: { storyId: 'story-123', notificationsEnabled: true },
      });

      const result = resolver.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
      });

      // Requirement 4: FOLLOW trả lỗi DOMAIN_NOT_SUPPORTED rõ ràng; không dùng REJECTED_STALE
      expect(result.status).toBe('DOMAIN_NOT_SUPPORTED');
      expect(result.status).not.toBe('REJECTED_STALE');
      expect(result.reason).toBe('FOLLOW_DOMAIN_NOT_SUPPORTED');
      expect(result.message).toContain('Phase 7F');
    });
  });

  describe('ConflictResolverDispatcher', () => {
    let dispatcher: ConflictResolverDispatcher;

    beforeEach(() => {
      dispatcher = new ConflictResolverDispatcher(
        new BookmarkConflictResolver(),
        new ProgressConflictResolver(),
        new HistoryConflictResolver(),
        new PreferenceConflictResolver(),
        new FollowConflictResolver(),
      );
    });

    it('should route BOOKMARK mutation to BookmarkConflictResolver', async () => {
      const mutation = createMockMutation({ domain: SyncDomain.BOOKMARK });
      const result = await dispatcher.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
      });
      expect(result.status).toBe('APPLIED');
    });

    it('should route FOLLOW mutation to FollowConflictResolver with DOMAIN_NOT_SUPPORTED', async () => {
      const mutation = createMockMutation({ domain: SyncDomain.FOLLOW });
      const result = await dispatcher.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
      });
      expect(result.status).toBe('DOMAIN_NOT_SUPPORTED');
    });

    it('should return DOMAIN_NOT_SUPPORTED for unrecognized domain', async () => {
      const mutation = createMockMutation({ domain: 'UNKNOWN_DOMAIN' as any });
      const result = await dispatcher.resolve({
        userId: USER_ID,
        mutation,
        canonicalHash: 'hash',
        serverRevision: '100',
        minActiveRevision: '50',
      });
      expect(result.status).toBe('DOMAIN_NOT_SUPPORTED');
      expect(result.reason).toBe('UNRECOGNIZED_DOMAIN');
    });
  });
});
