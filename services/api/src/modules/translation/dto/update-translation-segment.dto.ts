import { IsBoolean, IsInt, IsString, Min, ValidateIf } from 'class-validator';
import { UpdateTranslationSegmentRequest } from '@omninovel/shared';

export class UpdateTranslationSegmentDto implements UpdateTranslationSegmentRequest {
  @ValidateIf((_, val) => val !== undefined)
  @IsString()
  translatedText?: string;

  @ValidateIf((_, val) => val !== undefined)
  @IsBoolean()
  isHumanVerified?: boolean;

  @IsInt()
  @Min(1)
  expectedVersion: number;
}
