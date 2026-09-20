import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateChecklistDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  assetsReturned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  accessRevoked?: boolean;

  // Explicit HR override: lets assetsReturned be marked (and the case be completed) while company assets
  // are still allocated — e.g. written off or lost. Recorded on the case.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  assetOverrideNote?: string;
}
