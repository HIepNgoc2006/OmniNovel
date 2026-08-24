import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';
import { MediaFormat, PublicationFormat } from '@omninovel/shared';

export class CreateStoryDto {
  @IsString()
  @IsNotEmpty({ message: 'Tiêu đề bộ truyện không được để trống.' })
  title: string;

  @IsEnum(MediaFormat, { message: 'Media format phải là COMIC hoặc NOVEL.' })
  mediaFormat: MediaFormat;

  @IsEnum(PublicationFormat, {
    message:
      'Publication format phải là MANGA, MANHWA, MANHUA, WEBTOON, LIGHT_NOVEL hoặc WEB_NOVEL.',
  })
  publicationFormat: PublicationFormat;

  @IsString()
  @IsOptional()
  originCountry?: string;

  @IsString()
  @IsOptional()
  originalLanguage?: string;

  @IsString()
  @IsNotEmpty({ message: 'Ảnh bìa coverUrl không được để trống.' })
  coverUrl: string;

  @IsString()
  @IsOptional()
  summary?: string;
}
