import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
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

  // Same safety-cap-not-page-through-UI rationale as
  // QueryAttendanceDto.limit — see that file's comment.
  @ApiPropertyOptional({ default: 1000, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit: number = 1000;
}
