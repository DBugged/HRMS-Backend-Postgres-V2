import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { IsStrongPassword } from '../../common/password-policy';

export class ResetPasswordDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  token!: string;

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  password!: string;
}
