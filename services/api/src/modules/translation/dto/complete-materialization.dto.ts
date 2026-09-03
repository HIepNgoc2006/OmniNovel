import { IsInt, Min, IsEnum, IsDefined } from 'class-validator';
import { MediaFormat } from '@omninovel/shared';

export class CompleteMaterializationDto {
  @IsInt()
  @Min(1)
  targetRevision!: number;

  @IsEnum(MediaFormat)
  mediaFormat!: MediaFormat;

  @IsDefined()
  result!: unknown;
}
