import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type { ReportFormat } from '../report-export';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

const FORMATS: ReportFormat[] = ['xlsx', 'csv', 'pdf'];

// Shared by the operational reports (overtime, regularization, loans, reimbursements, tax declarations, payroll
// variance): an export format and, where it makes sense, a date range and a status filter.
export class OpsReportQueryDto {
  @ApiPropertyOptional({ enum: FORMATS, default: 'xlsx' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: ReportFormat;

  @ApiPropertyOptional({ example: '2026-06-01' })
  @IsOptional()
  @IsValidCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @IsValidCalendarDateString()
  to?: string;

  @ApiPropertyOptional({
    description:
      'Department id (ignored for a Manager, who always gets their own department)',
  })
  @IsOptional()
  @IsUUID()
  department?: string;

  @ApiPropertyOptional({
    description:
      'Status filter, e.g. PENDING / APPROVED / REJECTED (upper case)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z_]{2,30}$/)
  status?: string;

  @ApiPropertyOptional({
    description: 'Reimbursement category filter (upper case)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z_]{2,30}$/)
  category?: string;

  @ApiPropertyOptional({ example: '2026-27' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/)
  financialYear?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({ minimum: 2000, maximum: 2100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}
