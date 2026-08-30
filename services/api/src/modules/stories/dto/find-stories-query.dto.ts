import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsEnum,
  IsString,
  IsIn,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { MediaFormat, StoryStatus } from '@omninovel/shared';

export class FindStoriesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(MediaFormat, {
    message: `format phải là một trong các giá trị: ${Object.values(MediaFormat).join(', ')}`,
  })
  format?: MediaFormat;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  genre?: string;

  @IsOptional()
  @IsEnum(StoryStatus, {
    message: `status phải là một trong các giá trị: ${Object.values(StoryStatus).join(', ')}`,
  })
  status?: StoryStatus;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @IsOptional()
  @IsIn(['LATEST', 'VIEWS', 'POPULAR'], {
    message: 'sort phải là một trong các giá trị: LATEST, VIEWS, POPULAR',
  })
  sort?: 'LATEST' | 'VIEWS' | 'POPULAR' = 'LATEST';
}
