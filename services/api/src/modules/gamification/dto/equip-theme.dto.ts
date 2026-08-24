import { IsString, IsNotEmpty, Length } from 'class-validator';

export class EquipThemeDto {
  @IsString({ message: 'Theme ID phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Theme ID không được để trống' })
  @Length(2, 30, { message: 'Theme ID từ 2 đến 30 ký tự' })
  themeId: string;
}
