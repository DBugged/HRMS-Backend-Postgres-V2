import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateEmailSignatureDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  // Deliberately not @IsNotEmpty — an empty string is a valid signature
  // body (blank sign-off for that named entry).
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  html?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
