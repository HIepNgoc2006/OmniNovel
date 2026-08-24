import { IsUUID, IsNotEmpty, IsInt, Min, IsNumber, Max } from 'class-validator';

export class ReadChapterRewardDto {
  @IsUUID(undefined, { message: 'Chapter ID phải là UUID hợp lệ' })
  @IsNotEmpty({ message: 'Chapter ID không được để trống' })
  chapterId: string;

  @IsInt({ message: 'Thời gian đọc phải là số nguyên giây' })
  @Min(0, { message: 'Thời gian đọc không được âm' })
  readingDurationSeconds: number;

  @IsNumber({}, { message: 'Tiến độ đọc phải là số phần trăm (0-100)' })
  @Min(0, { message: 'Tiến độ đọc tối thiểu là 0%' })
  @Max(100, { message: 'Tiến độ đọc tối đa là 100%' })
  progressPercentage: number;
}
