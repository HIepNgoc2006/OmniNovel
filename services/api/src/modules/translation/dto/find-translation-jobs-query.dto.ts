import { IsOptional, IsInt, Min, Max, IsUUID, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { TranslationJobStatus } from '@omninovel/shared';

export class FindTranslationJobsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsUUID('4', { message: 'storyId phải là UUID-v4 hợp lệ.' })
  storyId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'projectId phải là UUID-v4 hợp lệ.' })
  projectId?: string;

  @IsOptional()
  @IsEnum(TranslationJobStatus, {
    message: `status phải là một trong các giá trị: ${Object.values(TranslationJobStatus).join(', ')}`,
  })
  status?: TranslationJobStatus;
}
