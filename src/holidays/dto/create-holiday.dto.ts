import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { HolidayType } from '@prisma/client';

// date is validated as YYYY-MM-DD (not @IsDateString, which accepts full
// ISO datetimes) — mirrors the old system's DATE_RE and the fact that
// `date` is stored as a plain string, never a time-of-day.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateHolidayDto {
  @ApiProperty({ example: 'Diwali' })
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: '2026-11-08' })
  @Matches(DATE_RE, { message: 'date must be in YYYY-MM-DD format' })
  date!: string;

  @ApiPropertyOptional({ description: 'null/omitted = company-wide' })
  @IsOptional()
  @IsUUID()
  department?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;

  @ApiPropertyOptional({ enum: HolidayType, default: HolidayType.COMPANY })
  @IsOptional()
  @IsEnum(HolidayType)
  type?: HolidayType;

  @ApiPropertyOptional({ example: 'Maharashtra' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
