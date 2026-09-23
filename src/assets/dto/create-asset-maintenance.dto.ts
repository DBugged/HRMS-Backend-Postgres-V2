import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetMaintenanceStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { DATE_RE } from './create-asset.dto';

export class CreateAssetMaintenanceDto {
  @ApiProperty({ example: '2026-06-10' })
  @Matches(DATE_RE, { message: 'serviceDate must be in YYYY-MM-DD format' })
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
  @Matches(DATE_RE, {
    message: 'serviceStartDate must be in YYYY-MM-DD format',
  })
  serviceStartDate?: string;

  @ApiPropertyOptional({ example: '2026-06-14' })
  @IsOptional()
  @Matches(DATE_RE, {
    message: 'serviceCompletionDate must be in YYYY-MM-DD format',
  })
  serviceCompletionDate?: string;

  @ApiPropertyOptional({ example: '2026-12-10' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'nextServiceDate must be in YYYY-MM-DD format' })
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
