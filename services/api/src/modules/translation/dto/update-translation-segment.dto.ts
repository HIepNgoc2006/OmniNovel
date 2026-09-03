import {
  IsBoolean,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { UpdateTranslationSegmentRequest } from '@omninovel/shared';

export class UpdateTranslationSegmentDto
  implements UpdateTranslationSegmentRequest
{
  @ValidateIf((_, val) => val !== undefined)
  @IsString()
  @MaxLength(50000)
  translatedText?: string;

  @ValidateIf((_, val) => val !== undefined)
  @IsBoolean()
  isHumanVerified?: boolean;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  expectedVersion: number;
}
