import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import type { ReportFormat } from '../report-export';

const FORMATS: ReportFormat[] = ['xlsx', 'csv', 'pdf'];

export class Form16ReportQueryDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(/^\d{4}-\d{2}$/, {
    message: 'financialYear must be in YYYY-YY format, e.g. 2026-27',
  })
  financialYear!: string;

  @ApiPropertyOptional({ enum: FORMATS, default: 'xlsx' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: ReportFormat;
}
