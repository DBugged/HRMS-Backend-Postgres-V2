import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AttendanceStatus } from '@prisma/client';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class QueryAttendanceDto {
  // Real server-side pagination (skip/take + a DB count), same contract as
  // /audit-logs and /employees. The frontend still fetches one large page
  // (limit=1000) and paginates/filters client-side via EnterpriseTable —
  // that UX choice is unchanged — but the API itself no longer just caps
  // an unbounded findMany; `total` below is a real count, not data.length,
  // so any future caller that *does* want to page through can.
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 1000, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit: number = 1000;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  department?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be in YYYY-MM-DD format' })
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be in YYYY-MM-DD format' })
  to?: string;

  @ApiPropertyOptional({ enum: AttendanceStatus })
  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  // Filters on the `regularization.status` JSON field — lets HR/Manager
  // pull a dedicated "awaiting my approval" queue (regularizationStatus=
  // pending) independent of whatever date/status filters the main
  // attendance table currently has applied, since a regularization can be
  // requested for a date well outside today's default view.
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  regularizationStatus?: 'pending' | 'approved' | 'rejected';
}
