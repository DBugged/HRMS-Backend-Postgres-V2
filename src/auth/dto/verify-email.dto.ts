import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty()
  @IsEmail()
  email!: string;
}
