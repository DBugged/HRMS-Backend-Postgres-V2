import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CcLoginDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  password!: string;

  // Two-factor sign-in is not built yet; accepted so the panel's form works unchanged, and ignored.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  totp?: string;
}

export class CcForgotPasswordDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class CcResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  token!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  password!: string;
}
