import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetMaintenanceStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class CreateAssetMaintenanceDto {
  @ApiProperty({ example: '2026-06-10' })
  @IsValidCalendarDateString()
  serviceDate!: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  issue!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serviceProvider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'serviceCost cannot be negative.' })
  serviceCost?: number;

  @ApiPropertyOptional({ enum: AssetMaintenanceStatus })
  @IsOptional()
  @IsEnum(AssetMaintenanceStatus)
  serviceStatus?: AssetMaintenanceStatus;

  @ApiPropertyOptional({ example: '2026-06-10' })
  @IsOptional()
  @IsValidCalendarDateString()
  serviceStartDate?: string;

  @ApiPropertyOptional({ example: '2026-06-14' })
  @IsOptional()
  @IsValidCalendarDateString()
  serviceCompletionDate?: string;

  @ApiPropertyOptional({ example: '2026-12-10' })
  @IsOptional()
  @IsValidCalendarDateString()
  nextServiceDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  warrantyClaim?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;
}
