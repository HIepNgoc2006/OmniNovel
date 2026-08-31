import {
  IsUUID,
  IsOptional,
  IsNumber,
  Min,
  Max,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ReadingMode } from '@omninovel/shared';

export class UpdateReadingProgressDto {
  @IsUUID('4', { message: 'chapterId phải là định dạng UUID hợp lệ' })
  chapterId: string;

  @IsOptional()
  @IsUUID('4', { message: 'chapterVersionId phải là định dạng UUID hợp lệ' })
  chapterVersionId?: string;

  @IsOptional()
  @IsIn(['WEBTOON', 'PAGED', 'NOVEL'], {
    message: 'readingMode phải là WEBTOON, PAGED hoặc NOVEL',
  })
  readingMode?: ReadingMode | string;

  @Type(() => Number)
  @IsNumber({}, { message: 'progressPercentage phải là một số' })
  @Min(0, { message: 'progressPercentage không được nhỏ hơn 0' })
  @Max(100, { message: 'progressPercentage không được lớn hơn 100' })
  progressPercentage: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'scrollPosition phải là một số' })
  @Min(0, { message: 'scrollPosition không được nhỏ hơn 0' })
  scrollPosition: number;

  @IsOptional()
  @IsUUID('4', { message: 'storyId phải là định dạng UUID hợp lệ' })
  storyId?: string;
}
