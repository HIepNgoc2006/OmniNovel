import { IsNotEmpty, IsString } from 'class-validator';

export class ReactivateAccountDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên đăng nhập hoặc email không được để trống.' })
  identifier: string;

  @IsString()
  @IsNotEmpty({ message: 'Mật khẩu không được để trống.' })
  password: string;
}
