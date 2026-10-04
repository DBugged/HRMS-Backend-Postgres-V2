import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';
import type { ReportFormat } from '../../reports/report-export';

const FORMATS: ReportFormat[] = ['xlsx', 'csv', 'pdf'];
const TAX_YEAR = /^\d{4}-\d{2}$/;
const TAX_YEAR_MSG = 'financialYear must be in YYYY-YY format, e.g. 2026-27';

export class TdsMonthQueryDto {
  @ApiProperty({ minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiPropertyOptional({ enum: FORMATS, default: 'xlsx' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: ReportFormat;
}

export class TdsQuarterQueryDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(TAX_YEAR, { message: TAX_YEAR_MSG })
  financialYear!: string;

  @ApiProperty({ minimum: 1, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quarter!: number;

  @ApiPropertyOptional({ enum: FORMATS, default: 'xlsx' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: ReportFormat;
}

export class TdsYearQueryDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(TAX_YEAR, { message: TAX_YEAR_MSG })
  financialYear!: string;

  @ApiPropertyOptional({ enum: FORMATS, default: 'xlsx' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: ReportFormat;
}

export class ChallanListQueryDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(TAX_YEAR, { message: TAX_YEAR_MSG })
  financialYear!: string;
}

export class CreateChallanDto {
  @ApiProperty({
    description: 'Month the tax was deducted in',
    minimum: 1,
    maximum: 12,
  })
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty()
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({
    example: '0510308',
    description: '7-digit BSR code of the bank branch',
  })
  @Matches(/^\d{7}$/, { message: 'BSR code must be 7 digits.' })
  bsrCode!: string;

  @ApiProperty({
    example: '00123',
    description: 'Challan serial number (1-5 digits)',
  })
  @Matches(/^\d{1,5}$/, {
    message: 'Challan serial number must be 1-5 digits.',
  })
  challanSerialNo!: string;

  @ApiProperty({ example: '2026-11-06' })
  @IsValidCalendarDateString()
  depositDate!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000_000)
  tdsAmount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  interest?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateChallanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{7}$/, { message: 'BSR code must be 7 digits.' })
  bsrCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{1,5}$/, {
    message: 'Challan serial number must be 1-5 digits.',
  })
  challanSerialNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsValidCalendarDateString()
  depositDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000_000)
  tdsAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  interest?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SetStatementDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(TAX_YEAR, { message: TAX_YEAR_MSG })
  financialYear!: string;

  @ApiProperty({ minimum: 1, maximum: 4 })
  @IsInt()
  @Min(1)
  @Max(4)
  quarter!: number;

  @ApiPropertyOptional({
    example: '138',
    description:
      'Form number of the filed statement (138 from 1-Apr-2026, 24Q before)',
  })
  @IsOptional()
  @IsIn(['138', '24Q'])
  formType?: string;

  @ApiProperty({
    description: 'Acknowledgement / receipt number from the filed statement',
  })
  @Matches(/^[A-Za-z0-9]{8,20}$/, {
    message: 'Receipt number must be 8-20 letters/digits.',
  })
  receiptNumber!: string;

  @ApiPropertyOptional({ example: '2026-10-28' })
  @IsOptional()
  @IsValidCalendarDateString()
  filedOn?: string;
}

export class Form130QueryDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(TAX_YEAR, { message: TAX_YEAR_MSG })
  financialYear!: string;
}
