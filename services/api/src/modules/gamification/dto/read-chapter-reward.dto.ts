import { IsUUID, IsNotEmpty } from 'class-validator';

export class ReadChapterRewardDto {
  @IsUUID(undefined, { message: 'Chapter ID phải là UUID hợp lệ' })
  @IsNotEmpty({ message: 'Chapter ID không được để trống' })
  chapterId: string;
}
