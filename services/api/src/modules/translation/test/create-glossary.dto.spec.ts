import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGlossaryDto } from '../dto/create-glossary.dto';

describe('CreateGlossaryDto Validation & Normalization (#189)', () => {
  const validProjectId = '11111111-1111-4111-8111-111111111111';

  it('normalizes and trims whitespace on sourceTerm, targetTerm, and category (" Hero " -> canonical "Hero")', async () => {
    const dto = plainToInstance(CreateGlossaryDto, {
      projectId: validProjectId,
      sourceTerm: '  Hero  ',
      targetTerm: '  Anh hùng  ',
      category: '  CHARACTER_NAME  ',
    });

    expect(dto.sourceTerm).toBe('Hero');
    expect(dto.targetTerm).toBe('Anh hùng');
    expect(dto.category).toBe('CHARACTER_NAME');

    const errors = await validate(dto);
    expect(errors).toEqual([]);
  });

  it('rejects whitespace-only sourceTerm ("   ") with validation error', async () => {
    const dto = plainToInstance(CreateGlossaryDto, {
      projectId: validProjectId,
      sourceTerm: '   ',
      targetTerm: 'Anh hùng',
    });

    const errors = await validate(dto);
    expect(errors.some((err) => err.property === 'sourceTerm')).toBe(true);
  });

  it('rejects whitespace-only targetTerm ("   ") with validation error', async () => {
    const dto = plainToInstance(CreateGlossaryDto, {
      projectId: validProjectId,
      sourceTerm: 'Hero',
      targetTerm: '   ',
    });

    const errors = await validate(dto);
    expect(errors.some((err) => err.property === 'targetTerm')).toBe(true);
  });

  it('rejects sourceTerm exceeding 100 characters', async () => {
    const dto = plainToInstance(CreateGlossaryDto, {
      projectId: validProjectId,
      sourceTerm: 'a'.repeat(101),
      targetTerm: 'Valid Target',
    });

    const errors = await validate(dto);
    expect(errors.some((err) => err.property === 'sourceTerm')).toBe(true);
  });

  it('rejects targetTerm exceeding 100 characters', async () => {
    const dto = plainToInstance(CreateGlossaryDto, {
      projectId: validProjectId,
      sourceTerm: 'Valid Source',
      targetTerm: 'b'.repeat(101),
    });

    const errors = await validate(dto);
    expect(errors.some((err) => err.property === 'targetTerm')).toBe(true);
  });

  it('rejects category exceeding 50 characters', async () => {
    const dto = plainToInstance(CreateGlossaryDto, {
      projectId: validProjectId,
      sourceTerm: 'Valid Source',
      targetTerm: 'Valid Target',
      category: 'c'.repeat(51),
    });

    const errors = await validate(dto);
    expect(errors.some((err) => err.property === 'category')).toBe(true);
  });

  it('allows optional category to be undefined or empty string fallback', async () => {
    const dto = plainToInstance(CreateGlossaryDto, {
      projectId: validProjectId,
      sourceTerm: 'Hero',
      targetTerm: 'Anh hùng',
    });

    expect(dto.category).toBeUndefined();
    const errors = await validate(dto);
    expect(errors).toEqual([]);
  });
});
