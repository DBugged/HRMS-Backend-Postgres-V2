import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';
import { NormalizeEmail } from '../../common/normalize-input';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'founder@acme.test' })
  @NormalizeEmail()
  @IsEmail()
  email!: string;
}
