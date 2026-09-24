import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ChapterReportErrorType,
  CreateChapterReportRequest,
} from '@omninovel/shared';

export class CreateChapterReportDto implements CreateChapterReportRequest {
  @IsUUID('4', { message: 'chapterVersionId phải là UUID v4 hợp lệ.' })
  chapterVersionId: string;

  @IsEnum(ChapterReportErrorType, {
    message: 'errorType không hợp lệ trong danh mục phân loại.',
  })
  errorType: ChapterReportErrorType;

  @IsOptional()
  @IsInt({ message: 'pageNumber phải là số nguyên.' })
  @Min(1, { message: 'pageNumber phải lớn hơn hoặc bằng 1.' })
  pageNumber?: number;

  @IsOptional()
  @IsString({ message: 'anchorBlockId phải là chuỗi ký tự.' })
  @MaxLength(100, { message: 'anchorBlockId không được vượt quá 100 ký tự.' })
  anchorBlockId?: string;

  @IsOptional()
  @IsString({ message: 'description phải là chuỗi ký tự.' })
  @MaxLength(1000, { message: 'description không được vượt quá 1000 ký tự.' })
  description?: string;
}
