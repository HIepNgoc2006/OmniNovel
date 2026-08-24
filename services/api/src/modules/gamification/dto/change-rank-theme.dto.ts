import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export class ChangeRankThemeDto {
  @IsString({ message: 'Theme ID phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Theme ID không được để trống' })
  @IsIn(['DEFAULT', 'TU_TIEN', 'GAME', 'DEMON_KING', 'MAGICIAN', 'SCI_FI'], {
    message:
      'Theme ID phải thuộc danh sách hợp lệ (DEFAULT, TU_TIEN, GAME, DEMON_KING, MAGICIAN, SCI_FI)',
  })
  themeId: string;
}
