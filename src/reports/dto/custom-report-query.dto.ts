import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import type { ReportFormat } from '../report-export';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

const FORMATS: (ReportFormat | 'json')[] = ['json', 'xlsx', 'csv', 'pdf'];

export class CustomReportQueryDto {
  @ApiProperty({
    description: 'One of the keys returned by GET /reports/custom/sources',
  })
  @IsString()
  source!: string;

  @ApiPropertyOptional({
    description: 'Comma-separated column keys; omit for all',
  })
  @IsOptional()
  @IsString()
  columns?: string;

  @ApiPropertyOptional({ description: 'Department id' })
  @IsOptional()
  @IsUUID()
  department?: string;

  @ApiPropertyOptional({ example: '2026-06-01' })
  @IsOptional()
  @IsValidCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @IsValidCalendarDateString()
  to?: string;

  @ApiPropertyOptional({
    description: "Source-specific status value, e.g. 'PRESENT'",
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: FORMATS, default: 'json' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: ReportFormat | 'json';
}
