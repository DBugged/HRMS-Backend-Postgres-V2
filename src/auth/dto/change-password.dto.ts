import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { IsStrongPassword } from '../../common/password-policy';

export class ChangePasswordDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  newPassword!: string;
}
