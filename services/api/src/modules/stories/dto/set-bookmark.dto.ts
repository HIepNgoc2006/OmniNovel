import { IsUUID, IsBoolean, IsNotEmpty } from 'class-validator';

export class SetBookmarkDto {
  @IsNotEmpty({ message: 'storyId không được để trống' })
  @IsUUID('4', { message: 'storyId phải là UUID v4 hợp lệ' })
  storyId: string;

  @IsNotEmpty({ message: 'isBookmarked không được để trống' })
  @IsBoolean({ message: 'isBookmarked phải là boolean' })
  isBookmarked: boolean;
}
