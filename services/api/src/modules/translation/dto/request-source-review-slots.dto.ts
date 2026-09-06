import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const ALLOWED_SOURCE_REVIEW_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

export type AllowedSourceReviewMime = (typeof ALLOWED_SOURCE_REVIEW_MIMES)[number];

export class RequestSourceReviewSlotsPageDto {
  @IsInt()
  @Min(1)
  pageNumber: number;

  @IsString()
  @IsIn(ALLOWED_SOURCE_REVIEW_MIMES, {
    message: `mimeType phải là một trong: ${ALLOWED_SOURCE_REVIEW_MIMES.join(', ')}`,
  })
  mimeType: AllowedSourceReviewMime;
}

export class RequestSourceReviewSlotsDto {
  @IsInt()
  @Min(1)
  attemptNumber: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RequestSourceReviewSlotsPageDto)
  pages: RequestSourceReviewSlotsPageDto[];
}
