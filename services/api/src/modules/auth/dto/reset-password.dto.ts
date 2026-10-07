import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Token đặt lại mật khẩu không được để trống.' })
  token: string;

  @IsString()
  @IsNotEmpty({ message: 'Mật khẩu mới không được để trống.' })
  @MinLength(8, { message: 'Mật khẩu mới phải có tối thiểu 8 ký tự.' })
  newPassword: string;
}
