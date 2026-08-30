import {
  IsUUID,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
  IsArray,
  IsString,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TranslationJobStatus } from '@omninovel/shared';

export class WorkerSegmentDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  pageNumber?: number;

  @IsOptional()
  @IsString()
  anchorBlockId?: string;

  @IsOptional()
  @IsString()
  blockType?: string;

  @IsInt()
  @Min(1)
  sortOrder: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bboxX?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bboxY?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  bboxW?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  bboxH?: number;

  @IsString()
  @IsNotEmpty()
  rawText: string;

  @IsOptional()
  @IsString()
  translatedText?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number | null;
}

export class WorkerEventCallbackDto {
  @IsUUID()
  @IsNotEmpty()
  eventId: string;

  @IsInt()
  @Min(1)
  attemptNumber: number;

  @IsInt()
  @Min(1)
  sequence: number;

  @IsEnum(TranslationJobStatus)
  stage: TranslationJobStatus;

  @IsInt()
  @Min(0)
  progress: number;

  @IsOptional()
  @IsBoolean()
  heartbeat?: boolean;

  @IsOptional()
  @IsObject()
  resultManifest?: Record<string, any>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkerSegmentDto)
  segments?: WorkerSegmentDto[];

  @IsOptional()
  @IsString()
  errorTrace?: string;
}
