import { IsEnum, IsOptional } from 'class-validator';
import { StoryStatus } from '@omninovel/shared';
import { LibraryPaginationQueryDto } from './library-pagination-query.dto';

export class FindBookmarksQueryDto extends LibraryPaginationQueryDto {
  @IsOptional()
  @IsEnum(StoryStatus, {
    message: `status phải là một trong các giá trị: ${Object.values(StoryStatus).join(', ')}`,
  })
  status?: StoryStatus;
}
