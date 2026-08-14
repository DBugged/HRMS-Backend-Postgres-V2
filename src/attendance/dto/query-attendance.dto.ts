import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';
import { AttendanceStatus } from '@prisma/client';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class QueryAttendanceDto {
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
}
