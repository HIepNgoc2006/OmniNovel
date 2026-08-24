import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên người dùng không được để trống.' })
  @MinLength(3, { message: 'Tên người dùng phải có tối thiểu 3 ký tự.' })
  username: string;

  @IsEmail({}, { message: 'Định dạng email không hợp lệ.' })
  @IsNotEmpty({ message: 'Email không được để trống.' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'Mật khẩu không được để trống.' })
  @MinLength(8, { message: 'Mật khẩu phải có tối thiểu 8 ký tự.' })
  password: string;
}
