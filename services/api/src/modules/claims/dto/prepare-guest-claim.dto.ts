import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum CanonicalReadingMode {
  WEBTOON = 'WEBTOON',
  PAGED = 'PAGED',
  NOVEL = 'NOVEL',
}

export class GuestBookmarkItemDto {
  @IsUUID('4', { message: 'storyId must be a valid UUID v4' })
  storyId: string;

  @IsOptional()
  @IsString()
  createdAt?: string;
}

export class GuestHistoryItemDto {
  @IsUUID('4', { message: 'storyId must be a valid UUID v4' })
  storyId: string;

  @IsUUID('4', { message: 'chapterId must be a valid UUID v4' })
  chapterId: string;

  @IsNumber({}, { message: 'progressPercentage must be a number' })
  @Min(0, { message: 'progressPercentage cannot be less than 0' })
  @Max(100, { message: 'progressPercentage cannot exceed 100' })
  progressPercentage: number;

  @IsOptional()
  @IsString()
  readAt?: string;
}

export class GuestProgressItemDto {
  @IsUUID('4', { message: 'storyId must be a valid UUID v4' })
  storyId: string;

  @IsUUID('4', { message: 'chapterId must be a valid UUID v4' })
  chapterId: string;

  @IsOptional()
  @IsUUID('4', { message: 'chapterVersionId must be a valid UUID v4' })
  chapterVersionId?: string | null;

  @IsEnum(CanonicalReadingMode, {
    message: 'readingMode must be WEBTOON, PAGED, or NOVEL',
  })
  readingMode: CanonicalReadingMode;

  @IsInt({ message: 'pageIndex must be an integer' })
  @Min(1, { message: 'pageIndex must be >= 1 (1-based index)' })
  pageIndex: number;

  @IsNumber({}, { message: 'scrollPosition must be a number' })
  @Min(0)
  scrollPosition: number;

  @IsNumber({}, { message: 'progressPercentage must be a number' })
  @Min(0)
  @Max(100)
  progressPercentage: number;

  @IsOptional()
  @IsString()
  anchorBlockId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  textOffset?: number;

  @IsOptional()
  @IsString()
  updatedAt?: string;
}

export class PrepareGuestClaimDto {
  @IsUUID('4', { message: 'guestProfileId must be a valid UUID v4' })
  guestProfileId: string;

  @IsArray()
  @ArrayMaxSize(500, { message: 'bookmarks array cannot exceed 500 items' })
  @ValidateNested({ each: true })
  @Type(() => GuestBookmarkItemDto)
  bookmarks: GuestBookmarkItemDto[];

  @IsArray()
  @ArrayMaxSize(1000, { message: 'history array cannot exceed 1000 items' })
  @ValidateNested({ each: true })
  @Type(() => GuestHistoryItemDto)
  history: GuestHistoryItemDto[];

  @IsArray()
  @ArrayMaxSize(500, { message: 'progress array cannot exceed 500 items' })
  @ValidateNested({ each: true })
  @Type(() => GuestProgressItemDto)
  progress: GuestProgressItemDto[];
}
