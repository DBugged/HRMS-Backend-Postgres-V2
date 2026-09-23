import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { DATE_RE } from './create-asset.dto';

// The warranty subset of CreateAssetDto, as its own endpoint — the Warranty
// tab saves independently of the Overview form.
export class UpdateAssetWarrantyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warrantyProvider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warrantyNumber?: string;

  @ApiPropertyOptional({ example: '2026-06-10' })
  @IsOptional()
  @Matches(DATE_RE, {
    message: 'warrantyStartDate must be in YYYY-MM-DD format',
  })
  warrantyStartDate?: string;

  @ApiPropertyOptional({ example: '2028-06-09' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'warrantyEndDate must be in YYYY-MM-DD format' })
  warrantyEndDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  warrantyPeriodMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supportContact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supportEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supportPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warrantyTerms?: string;
}
