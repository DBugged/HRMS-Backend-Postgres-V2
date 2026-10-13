import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Matches,
} from 'class-validator';
import type { ReportFormat } from '../../reports/report-export';

const FORMATS: ReportFormat[] = ['xlsx', 'pdf'];

export class ExportLeaveTrackerBalancesDto {
  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiPropertyOptional({
    description:
      'YYYY-MM. When given, balances are those of the leave year containing that month (the year field is then ignored), leave taken and WFH days are counted for that month only.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' })
  period?: string;

  @ApiPropertyOptional({
    description:
      'ADMIN/HR only — narrows to one department. Ignored (server-forced to their own) for MANAGER.',
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ enum: FORMATS, default: 'xlsx' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: 'xlsx' | 'pdf';
}
