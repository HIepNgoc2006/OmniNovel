import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TranslationJobStatus } from '@omninovel/shared';
import { FindTranslationJobsQueryDto } from '../dto/find-translation-jobs-query.dto';

describe('FindTranslationJobsQueryDto (#145)', () => {
  it('normalizes comma-delimited statuses and trims search', async () => {
    const dto = plainToInstance(FindTranslationJobsQueryDto, {
      statuses: 'QUEUED, TRANSLATING,QUALITY_CHECK',
      search: '  One Piece  ',
    });

    expect(dto.statuses).toEqual([
      TranslationJobStatus.QUEUED,
      TranslationJobStatus.TRANSLATING,
      TranslationJobStatus.QUALITY_CHECK,
    ]);
    expect(dto.search).toBe('One Piece');
    expect(await validate(dto)).toEqual([]);
  });

  it('accepts repeated-array status values', async () => {
    const dto = plainToInstance(FindTranslationJobsQueryDto, {
      statuses: ['QUEUED', 'TRANSLATING,OCR'],
    });

    expect(dto.statuses).toEqual([
      TranslationJobStatus.QUEUED,
      TranslationJobStatus.TRANSLATING,
      TranslationJobStatus.OCR,
    ]);
    expect(await validate(dto)).toEqual([]);
  });

  it('rejects invalid statuses', async () => {
    const dto = plainToInstance(FindTranslationJobsQueryDto, {
      statuses: 'QUEUED,PROCESSING',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'statuses')).toBe(true);
  });
});
