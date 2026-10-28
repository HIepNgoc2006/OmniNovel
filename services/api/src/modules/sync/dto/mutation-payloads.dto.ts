import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ReadingMode } from '../interfaces/sync.types';

export class BookmarkMutationPayloadDto {
  @IsUUID('4', { message: 'storyId must be a valid UUID v4' })
  storyId: string;
}

export class ProgressMutationPayloadDto {
  @IsUUID('4', { message: 'storyId must be a valid UUID v4' })
  storyId: string;

  @IsUUID('4', { message: 'chapterId must be a valid UUID v4' })
  chapterId: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID('4', { message: 'chapterVersionId must be a valid UUID v4 or null' })
  chapterVersionId?: string | null;

  @IsEnum(ReadingMode, {
    message: 'readingMode must be WEBTOON, PAGED, or NOVEL',
  })
  readingMode: ReadingMode;

  @IsInt({ message: 'pageIndex must be an integer' })
  @Min(1, { message: 'pageIndex must be >= 1 (1-based index)' })
  pageIndex: number;

  @IsNumber({}, { message: 'scrollPosition must be a number' })
  @Min(0, { message: 'scrollPosition cannot be negative' })
  scrollPosition: number;

  @IsNumber({}, { message: 'progressPercentage must be a number' })
  @Min(0, { message: 'progressPercentage cannot be less than 0' })
  @Max(100, { message: 'progressPercentage cannot exceed 100' })
  progressPercentage: number;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString({ message: 'anchorBlockId must be a string or null' })
  anchorBlockId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt({ message: 'textOffset must be an integer or null' })
  @Min(0, { message: 'textOffset cannot be negative' })
  textOffset?: number | null;

  @IsOptional()
  @IsBoolean({ message: 'forceRewind must be a boolean' })
  forceRewind?: boolean;
}

export class HistoryMutationPayloadDto {
  @IsUUID('4', { message: 'storyId must be a valid UUID v4' })
  storyId: string;

  @IsUUID('4', { message: 'chapterId must be a valid UUID v4' })
  chapterId: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID('4', { message: 'chapterVersionId must be a valid UUID v4 or null' })
  chapterVersionId?: string | null;

  @IsNumber({}, { message: 'progressPercentage must be a number' })
  @Min(0, { message: 'progressPercentage cannot be less than 0' })
  @Max(100, { message: 'progressPercentage cannot exceed 100' })
  progressPercentage: number;

  /**
   * Bắt buộc: observedHistoryEpoch phải là số nguyên >= 0 để đối chiếu Strict Equality
   * với effectiveEpoch = MAX(storyTombstoneEpoch ?? 0, globalSentinelEpoch ?? 0) của Phase 7B.
   */
  @IsInt({ message: 'observedHistoryEpoch must be an integer' })
  @Min(0, { message: 'observedHistoryEpoch cannot be negative' })
  observedHistoryEpoch: number;
}

export class PreferenceMutationPayloadDto {
  @IsString({ message: 'key must be a string' })
  @IsNotEmpty({ message: 'key cannot be empty' })
  key: string;

  @IsDefined({ message: 'value is required' })
  value: unknown;
}
