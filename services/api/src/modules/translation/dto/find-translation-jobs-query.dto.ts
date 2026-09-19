import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { TranslationJobStatus } from '@omninovel/shared';

function normalizeStatuses(value: unknown): unknown {
  const rawValues = Array.isArray(value) ? value : [value];
  return rawValues
    .flatMap((item) =>
      typeof item === 'string' ? item.split(',') : [item],
    )
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '' && item !== null && item !== undefined);
}

export class FindTranslationJobsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsUUID('4', { message: 'storyId phải là UUID-v4 hợp lệ.' })
  storyId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'projectId phải là UUID-v4 hợp lệ.' })
  projectId?: string;

  @IsOptional()
  @IsEnum(TranslationJobStatus, {
    message: `status phải là một trong các giá trị: ${Object.values(TranslationJobStatus).join(', ')}`,
  })
  status?: TranslationJobStatus;

  @IsOptional()
  @Transform(({ value }) => normalizeStatuses(value))
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(TranslationJobStatus, {
    each: true,
    message: `statuses chỉ được chứa: ${Object.values(TranslationJobStatus).join(', ')}`,
  })
  statuses?: TranslationJobStatus[];

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  search?: string;
}
