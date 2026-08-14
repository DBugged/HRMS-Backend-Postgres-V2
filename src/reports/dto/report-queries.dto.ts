import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import { LeaveStatus } from '@prisma/client';
import type { ReportFormat } from '../report-export';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FORMATS: ReportFormat[] = ['xlsx', 'csv', 'pdf'];

class FormatQueryDto {
  @ApiPropertyOptional({ enum: FORMATS, default: 'xlsx' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: ReportFormat;
}

export class AttendanceReportQueryDto extends FormatQueryDto {
  @ApiPropertyOptional({ example: '2026-06-01' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be in YYYY-MM-DD format' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be in YYYY-MM-DD format' })
  to?: string;

  @ApiPropertyOptional({ description: 'Department id' })
  @IsOptional()
  @IsUUID()
  department?: string;
}

export class LeaveReportQueryDto extends FormatQueryDto {
  @ApiPropertyOptional({ enum: LeaveStatus })
  @IsOptional()
  @IsEnum(LeaveStatus)
  status?: LeaveStatus;
}

export class LeaveBalanceReportQueryDto extends FormatQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;
}

export class EmployeeLeaveHistoryReportQueryDto extends FormatQueryDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;
}

export class DepartmentLeaveSummaryReportQueryDto extends FormatQueryDto {
  @ApiPropertyOptional({ example: '2026-06-01' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be in YYYY-MM-DD format' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be in YYYY-MM-DD format' })
  to?: string;
}

export class PayrollReportQueryDto extends FormatQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  month?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;
}

export class HeadcountReportQueryDto extends FormatQueryDto {
  @ApiPropertyOptional({ default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  months?: number;
}
