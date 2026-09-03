import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
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
