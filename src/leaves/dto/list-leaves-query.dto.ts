import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
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
}
