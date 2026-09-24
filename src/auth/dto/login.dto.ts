import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';
import { NormalizeEmail } from '../../common/normalize-input';

export class LoginDto {
  @ApiProperty({ example: 'founder@acme.test' })
  @NormalizeEmail()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsNotEmpty()
  password!: string;
}
