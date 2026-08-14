import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import type { ReportFormat } from '../report-export';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
  @Matches(DATE_RE, { message: 'from must be in YYYY-MM-DD format' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be in YYYY-MM-DD format' })
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
