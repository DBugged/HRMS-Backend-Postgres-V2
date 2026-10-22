import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { LeaveStatus } from '@prisma/client';

export class ListLeavesQueryDto {
  @ApiPropertyOptional({
    description:
      'Ignored for EMPLOYEE/MANAGER callers (forced to self/department)',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: LeaveStatus })
  @IsOptional()
  @IsEnum(LeaveStatus)
  status?: LeaveStatus;

  @ApiPropertyOptional({ description: 'Only approved leaves with a cancellation request waiting' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  cancelRequested?: boolean;

  // Real server-side pagination — see QueryAttendanceDto's comment for the
  // full rationale (frontend still requests one large page today, but
  // `total` is now a DB count, not data.length).
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @ApiPropertyOptional({ default: 1000, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit: number = 1000;
}
