import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class FileUploadRequestItemDto {
  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsOptional()
  contentType?: string;
}

export class RequestOutputUploadsDto {
  @IsInt()
  @Min(1)
  attemptNumber: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FileUploadRequestItemDto)
  files: FileUploadRequestItemDto[];
}
