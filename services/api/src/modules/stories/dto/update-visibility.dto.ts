import { IsEnum, IsNotEmpty } from 'class-validator';
import { StoryVisibility } from '@omninovel/shared';

export class UpdateVisibilityDto {
  @IsEnum(StoryVisibility, {
    message: 'Visibility phải là PUBLIC, UNLISTED hoặc PRIVATE.',
  })
  @IsNotEmpty({ message: 'Trạng thái visibility không được để trống.' })
  visibility: StoryVisibility;
}
