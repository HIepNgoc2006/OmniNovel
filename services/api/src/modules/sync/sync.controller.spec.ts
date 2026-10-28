import { Test, TestingModule } from '@nestjs/testing';
import { SyncController } from './sync.controller';
import { SyncService } from './services/sync.service';
import { SyncChangesQueryDto, SyncSnapshotQueryDto, PushMutationsBatchDto } from './dto';
import { SyncDomain, SyncOperation } from './interfaces/sync.types';

describe('SyncController', () => {
  let controller: SyncController;
  let syncService: jest.Mocked<SyncService>;

  const USER_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    syncService = {
      getChanges: jest.fn(),
      getSnapshot: jest.fn(),
      pushMutations: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [
        {
          provide: SyncService,
          useValue: syncService,
        },
      ],
    }).compile();

    controller = module.get<SyncController>(SyncController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getChanges', () => {
    it('should call syncService.getChanges with userId and query', async () => {
      const query: SyncChangesQueryDto = { after: '100', limit: 50 };
      const expected = {
        currentServerRevision: '110',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [],
      };
      syncService.getChanges.mockResolvedValueOnce(expected);

      const result = await controller.getChanges(USER_ID, query);
      expect(syncService.getChanges).toHaveBeenCalledWith(USER_ID, query);
      expect(result).toBe(expected);
    });
  });

  describe('getSnapshot', () => {
    it('should call syncService.getSnapshot with userId and query', async () => {
      const query: SyncSnapshotQueryDto = { limit: 100 };
      const expected = {
        snapshotRevision: '110',
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
      syncService.getSnapshot.mockResolvedValueOnce(expected);

      const result = await controller.getSnapshot(USER_ID, query);
      expect(syncService.getSnapshot).toHaveBeenCalledWith(USER_ID, query);
      expect(result).toBe(expected);
    });
  });

  describe('pushMutations', () => {
    it('should call syncService.pushMutations with userId and dto', async () => {
      const dto: PushMutationsBatchDto = {
        mutations: [
          {
            clientId: '22222222-2222-4222-8222-222222222222',
            mutationId: '33333333-3333-4333-8333-333333333333',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-1',
            operation: SyncOperation.UPSERT,
            baseServerRevision: '100',
            payload: { storyId: 'story-1' },
          },
        ],
      };
      const expected = {
        processedCount: 1,
        newServerRevision: '101',
        results: [
          {
            mutationId: '33333333-3333-4333-8333-333333333333',
            status: 'APPLIED' as const,
            assignedRevision: '101',
          },
        ],
      };
      syncService.pushMutations.mockResolvedValueOnce(expected);

      const result = await controller.pushMutations(USER_ID, dto);
      expect(syncService.pushMutations).toHaveBeenCalledWith(USER_ID, dto);
      expect(result).toBe(expected);
    });
  });
});
