import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsStrongPassword } from '../../common/password-policy';
import { NormalizeEmail, Trim } from '../../common/normalize-input';

export class RegisterDto {
  @ApiProperty({ example: 'Acme Corp' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  // Same rule as UpdateOrganizationDto.name: no control characters.
  @Matches(/^[^\p{Cc}]*$/u, {
    message: 'organizationName must not contain control characters',
  })
  organizationName!: string;

  // Trimmed first so a whitespace-only name fails @IsNotEmpty instead of
  // being stored as the founder's display name.
  @ApiProperty({ example: 'Jane Founder' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'founder@acme.test' })
  @NormalizeEmail()
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!', minLength: 10 })
  @IsStrongPassword()
  password!: string;

  // Required only while registration is invitation-only (REGISTRATION_ENABLED=false).
  @ApiPropertyOptional({ example: 'ACME-2026-INVITE' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  inviteCode?: string;
}
