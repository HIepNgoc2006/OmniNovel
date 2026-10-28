import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SyncChangesQueryDto } from './sync-changes-query.dto';
import { SyncSnapshotQueryDto } from './sync-snapshot-query.dto';
import { ClientMutationDto } from './client-mutation.dto';
import { PushMutationsBatchDto } from './push-mutations-batch.dto';
import {
  BookmarkMutationPayloadDto,
  HistoryMutationPayloadDto,
  ProgressMutationPayloadDto,
} from './mutation-payloads.dto';
import { ReadingMode, SyncDomain, SyncOperation } from '../interfaces/sync.types';

describe('Sync DTO Validations', () => {
  describe('SyncChangesQueryDto', () => {
    it('should validate valid after and limit values', async () => {
      const validCases = [
        {},
        { after: '0', limit: 100 },
        { after: '10425', limit: 1 },
        { after: '9007199254740995', limit: 500 }, // > 2^53 - 1
        { after: '9223372036854775807', limit: 500 }, // PostgreSQL signed BIGINT max (2^63 - 1)
      ];

      for (const item of validCases) {
        const dto = plainToInstance(SyncChangesQueryDto, item);
        const errors = await validate(dto);
        expect(errors.length).toBe(0);
      }
    });

    it('should reject invalid decimal string, whitespace, and values exceeding PostgreSQL BIGINT for after', async () => {
      const invalidCases = [
        { after: '-1' },
        { after: '10.5' },
        { after: 'abc' },
        { after: '12a' },
        { after: ' 100 ' },
        { after: '100 ' },
        { after: ' 100' },
        { after: '0x10' },
        { after: '9223372036854775808' }, // Exceeds signed BIGINT max
        { after: '999999999999999999999999' },
      ];

      for (const item of invalidCases) {
        const dto = plainToInstance(SyncChangesQueryDto, item);
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].property).toBe('after');
      }
    });

    it('should reject invalid limit values (bounds: 1..500)', async () => {
      const invalidCases = [
        { limit: 0 },
        { limit: -10 },
        { limit: 501 },
        { limit: 1000 },
        { limit: 1.5 },
      ];

      for (const item of invalidCases) {
        const dto = plainToInstance(SyncChangesQueryDto, item);
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].property).toBe('limit');
      }
    });
  });

  describe('SyncSnapshotQueryDto', () => {
    it('should accept valid cursor and limit', async () => {
      const dto = plainToInstance(SyncSnapshotQueryDto, {
        cursor: 'payloadB64.sigB64',
        limit: 200,
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should reject invalid limit outside 1..500', async () => {
      const dto = plainToInstance(SyncSnapshotQueryDto, { limit: 501 });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('limit');
    });
  });

  describe('PushMutationsBatchDto & ClientMutationDto', () => {
    const validMutation = {
      clientId: '11111111-1111-4111-8111-111111111111',
      mutationId: '22222222-2222-4222-8222-222222222222',
      domain: SyncDomain.BOOKMARK,
      entityId: '33333333-3333-4333-8333-333333333333',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '10425',
      payload: { storyId: '33333333-3333-4333-8333-333333333333' },
      clientCreatedAt: '2026-10-28T10:00:00.000Z',
    };

    it('should validate a batch with 1..100 mutations', async () => {
      const dto = plainToInstance(PushMutationsBatchDto, {
        mutations: [validMutation],
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should reject an empty mutations array (min 1)', async () => {
      const dto = plainToInstance(PushMutationsBatchDto, { mutations: [] });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('mutations');
    });

    it('should reject a batch exceeding 100 mutations (max 100)', async () => {
      const mutations = Array.from({ length: 101 }, (_, i) => ({
        ...validMutation,
        mutationId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      }));
      const dto = plainToInstance(PushMutationsBatchDto, { mutations });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('mutations');
    });

    it('should reject invalid UUIDs for clientId or mutationId', async () => {
      const invalidClientDto = plainToInstance(ClientMutationDto, {
        ...validMutation,
        clientId: 'invalid-uuid',
      });
      const errors1 = await validate(invalidClientDto);
      expect(errors1.some((e) => e.property === 'clientId')).toBe(true);

      const invalidMutationDto = plainToInstance(ClientMutationDto, {
        ...validMutation,
        mutationId: 'invalid-uuid',
      });
      const errors2 = await validate(invalidMutationDto);
      expect(errors2.some((e) => e.property === 'mutationId')).toBe(true);
    });

    it('should reject invalid domain or operation enums', async () => {
      const invalidDomain = plainToInstance(ClientMutationDto, {
        ...validMutation,
        domain: 'INVALID_DOMAIN',
      });
      const errors1 = await validate(invalidDomain);
      expect(errors1.some((e) => e.property === 'domain')).toBe(true);

      const invalidOp = plainToInstance(ClientMutationDto, {
        ...validMutation,
        operation: 'UPDATE', // Only UPSERT or DELETE allowed
      });
      const errors2 = await validate(invalidOp);
      expect(errors2.some((e) => e.property === 'operation')).toBe(true);
    });

    it('should reject non-decimal, whitespace, and out-of-range baseServerRevision', async () => {
      const invalidRevs = [
        '-5',
        '12.34',
        'abc',
        ' 100 ',
        '100 ',
        ' 100',
        '9223372036854775808', // Exceeds signed BIGINT max
        '999999999999999999999999',
      ];
      for (const rev of invalidRevs) {
        const dto = plainToInstance(ClientMutationDto, {
          ...validMutation,
          baseServerRevision: rev,
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'baseServerRevision')).toBe(
          true,
        );
      }
    });

    it('should accept valid 64-bit baseServerRevision up to PostgreSQL BIGINT max', async () => {
      const validRevs = [
        '0',
        '100',
        '9007199254740995', // > 2^53 - 1
        '9223372036854775807', // 2^63 - 1
      ];
      for (const rev of validRevs) {
        const dto = plainToInstance(ClientMutationDto, {
          ...validMutation,
          baseServerRevision: rev,
        });
        const errors = await validate(dto);
        expect(errors.length).toBe(0);
      }
    });

    it('should reject invalid payload types (null, array, string, number)', async () => {
      const invalidPayloads = [null, [1, 2, 3], 'string-payload', 12345];
      for (const p of invalidPayloads) {
        const dto = plainToInstance(ClientMutationDto, {
          ...validMutation,
          payload: p,
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'payload')).toBe(true);
      }
    });
  });

  describe('Nested Mutation Payloads', () => {
    it('should validate BookmarkMutationPayloadDto', async () => {
      const valid = plainToInstance(BookmarkMutationPayloadDto, {
        storyId: '33333333-3333-4333-8333-333333333333',
      });
      expect((await validate(valid)).length).toBe(0);

      const invalid = plainToInstance(BookmarkMutationPayloadDto, {
        storyId: 'not-a-uuid',
      });
      expect((await validate(invalid)).length).toBeGreaterThan(0);
    });

    it('should validate ProgressMutationPayloadDto (1-based pageIndex, 0..100 percentage)', async () => {
      const valid = plainToInstance(ProgressMutationPayloadDto, {
        storyId: '33333333-3333-4333-8333-333333333333',
        chapterId: '44444444-4444-4444-8444-444444444444',
        readingMode: ReadingMode.PAGED,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 50.5,
      });
      expect((await validate(valid)).length).toBe(0);

      // pageIndex < 1 must fail
      const badPageIndex = plainToInstance(ProgressMutationPayloadDto, {
        ...valid,
        pageIndex: 0,
      });
      expect((await validate(badPageIndex)).length).toBeGreaterThan(0);

      // progressPercentage > 100 must fail
      const badPercentage = plainToInstance(ProgressMutationPayloadDto, {
        ...valid,
        pageIndex: 1,
        progressPercentage: 105,
      });
      expect((await validate(badPercentage)).length).toBeGreaterThan(0);
    });

    it('should validate HistoryMutationPayloadDto and strictly enforce observedHistoryEpoch', async () => {
      const valid = plainToInstance(HistoryMutationPayloadDto, {
        storyId: '33333333-3333-4333-8333-333333333333',
        chapterId: '44444444-4444-4444-8444-444444444444',
        progressPercentage: 80,
        observedHistoryEpoch: 5,
      });
      expect((await validate(valid)).length).toBe(0);

      // Missing observedHistoryEpoch must fail
      const missingEpoch = plainToInstance(HistoryMutationPayloadDto, {
        storyId: '33333333-3333-4333-8333-333333333333',
        chapterId: '44444444-4444-4444-8444-444444444444',
        progressPercentage: 80,
      });
      expect((await validate(missingEpoch)).length).toBeGreaterThan(0);

      // Negative epoch must fail
      const negativeEpoch = plainToInstance(HistoryMutationPayloadDto, {
        ...valid,
        observedHistoryEpoch: -1,
      });
      expect((await validate(negativeEpoch)).length).toBeGreaterThan(0);
    });

    it('P1-02: should reject ClientMutationDto when entityId does not match domain payload or format', async () => {
      // 1. BOOKMARK entityId mismatch
      const bookmarkMismatch = plainToInstance(ClientMutationDto, {
        clientId: '11111111-1111-4111-8111-111111111111',
        mutationId: '22222222-2222-4222-8222-222222222222',
        domain: SyncDomain.BOOKMARK,
        entityId: '33333333-3333-4333-8333-333333333333',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: {
          storyId: '44444444-4444-4444-8444-444444444444', // Different from entityId!
        },
      });
      const bookmarkErrors = await validate(bookmarkMismatch);
      expect(bookmarkErrors.length).toBeGreaterThan(0);
      expect(JSON.stringify(bookmarkErrors)).toContain('does not match payload.storyId');

      // 2. PROGRESS payload invalid (pageIndex < 1)
      const progressInvalid = plainToInstance(ClientMutationDto, {
        clientId: '11111111-1111-4111-8111-111111111111',
        mutationId: '22222222-2222-4222-8222-222222222222',
        domain: SyncDomain.PROGRESS,
        entityId: '33333333-3333-4333-8333-333333333333',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: {
          storyId: '33333333-3333-4333-8333-333333333333',
          chapterId: '44444444-4444-4444-8444-444444444444',
          readingMode: 'PAGED',
          pageIndex: 0, // Invalid!
          scrollPosition: 0,
          progressPercentage: 50,
        },
      });
      const progressErrors = await validate(progressInvalid);
      expect(progressErrors.length).toBeGreaterThan(0);
      expect(JSON.stringify(progressErrors)).toContain('Invalid PROGRESS payload');

      // 3. PREFERENCE entityId mismatch
      const prefMismatch = plainToInstance(ClientMutationDto, {
        clientId: '11111111-1111-4111-8111-111111111111',
        mutationId: '22222222-2222-4222-8222-222222222222',
        domain: SyncDomain.PREFERENCE,
        entityId: 'theme',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: {
          key: 'font_family', // Mismatched!
          value: 'sans',
        },
      });
      const prefErrors = await validate(prefMismatch);
      expect(prefErrors.length).toBeGreaterThan(0);
      expect(JSON.stringify(prefErrors)).toContain('does not match payload.key');
    });
  });
});
