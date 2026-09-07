import { IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BadRequestException } from '@nestjs/common';

export class FindJobPreviewsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageNumber?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromPage?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toPage?: number;
}

export interface NormalizedPreviewWindow {
  fromPage: number;
  toPage: number;
}

export function normalizePreviewWindow(
  query: FindJobPreviewsQueryDto,
): NormalizedPreviewWindow {
  const hasPageNumber =
    query.pageNumber !== undefined && query.pageNumber !== null;
  const hasFromPage = query.fromPage !== undefined && query.fromPage !== null;
  const hasToPage = query.toPage !== undefined && query.toPage !== null;

  if (!hasPageNumber && !hasFromPage && !hasToPage) {
    throw new BadRequestException({
      code: 'PREVIEW_WINDOW_REQUIRED',
      message:
        'Preview window is required. Provide pageNumber or both fromPage and toPage.',
    });
  }

  if (hasPageNumber && (hasFromPage || hasToPage)) {
    throw new BadRequestException({
      code: 'PREVIEW_WINDOW_AMBIGUOUS',
      message: 'Cannot specify pageNumber together with fromPage or toPage.',
    });
  }

  if (hasFromPage !== hasToPage) {
    throw new BadRequestException({
      code: 'PREVIEW_RANGE_INCOMPLETE',
      message: 'Both fromPage and toPage must be provided for range queries.',
    });
  }

  if (hasFromPage && hasToPage) {
    const from = Number(query.fromPage);
    const to = Number(query.toPage);

    if (from > to) {
      throw new BadRequestException({
        code: 'INVALID_PREVIEW_RANGE',
        message: 'fromPage must be less than or equal to toPage.',
      });
    }

    if (to - from + 1 > 5) {
      throw new BadRequestException({
        code: 'WINDOW_TOO_LARGE',
        message: 'Preview window size cannot exceed 5 pages.',
      });
    }

    return { fromPage: from, toPage: to };
  }

  const page = Number(query.pageNumber);
  return { fromPage: page, toPage: page };
}
