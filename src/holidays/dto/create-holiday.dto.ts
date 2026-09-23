import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { HolidayType } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// date is validated as YYYY-MM-DD (not @IsDateString, which accepts full
// ISO datetimes) — `date` is stored as a plain string, never a time-of-day.
export class CreateHolidayDto {
  @ApiProperty({ example: 'Diwali' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '2026-11-08' })
  @IsValidCalendarDateString()
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
