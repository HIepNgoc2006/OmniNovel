import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
  Max,
} from 'class-validator';

export enum AllowedUploadFileType {
  MANGA_IMAGE = 'MANGA_IMAGE',
  MANGA_ZIP = 'MANGA_ZIP',
  NOVEL_EPUB = 'NOVEL_EPUB',
  NOVEL_MD = 'NOVEL_MD',
}

export class CreateUploadSessionDto {
  @IsUUID('4', { message: 'storyEditionId phải là UUID hợp lệ.' })
  @IsNotEmpty()
  storyEditionId: string;

  @IsUUID('4', { message: 'chapterVersionId phải là UUID hợp lệ.' })
  @IsOptional()
  chapterVersionId?: string;

  @IsEnum(AllowedUploadFileType, {
    message:
      'fileType phải là MANGA_IMAGE, MANGA_ZIP, NOVEL_EPUB hoặc NOVEL_MD.',
  })
  fileType: AllowedUploadFileType;

  @IsNumber()
  @Min(1, { message: 'Kích thước file phải lớn hơn 0 bytes.' })
  @Max(104857600, { message: 'Kích thước file tối đa là 100MB theo chuẩn an ninh Security SSoT.' }) // 100MB max limit
  expectedSize: number;
}
