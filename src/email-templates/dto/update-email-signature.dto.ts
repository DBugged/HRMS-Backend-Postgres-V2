import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateEmailSignatureDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  // Deliberately not @IsNotEmpty — an empty string is a valid signature
  // body (blank sign-off for that named entry).
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  html?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
