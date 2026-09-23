import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { LeaveStatus } from '@prisma/client';
import type { ReportFormat } from '../report-export';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

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
  @IsValidCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @IsValidCalendarDateString()
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
  @IsValidCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @IsValidCalendarDateString()
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

export class PayrollAuditReportQueryDto extends FormatQueryDto {
  @ApiPropertyOptional({ example: '2026-06-01' })
  @IsOptional()
  @IsValidCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @IsValidCalendarDateString()
  to?: string;
}

export class HeadcountReportQueryDto extends FormatQueryDto {
  @ApiPropertyOptional({ default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  months?: number;
}
