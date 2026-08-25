import {
  IsUUID,
  IsNotEmpty,
  IsInt,
  Min,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
  IsArray,
  IsString,
} from 'class-validator';
import { TranslationJobStatus } from '@omninovel/shared';

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
  segments?: Array<{
    pageNumber?: number;
    anchorBlockId?: string;
    sortOrder: number;
    bboxX?: number;
    bboxY?: number;
    bboxW?: number;
    bboxH?: number;
    rawText: string;
    translatedText?: string;
    confidence?: number;
  }>;

  @IsOptional()
  @IsString()
  errorTrace?: string;
}
