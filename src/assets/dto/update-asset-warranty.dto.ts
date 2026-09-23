import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

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
  @IsValidCalendarDateString()
  warrantyStartDate?: string;

  @ApiPropertyOptional({ example: '2028-06-09' })
  @IsOptional()
  @IsValidCalendarDateString()
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
