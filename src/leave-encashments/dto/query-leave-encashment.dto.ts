import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { LeaveEncashmentStatus } from '@prisma/client';

export class QueryLeaveEncashmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: LeaveEncashmentStatus })
  @IsOptional()
  @IsEnum(LeaveEncashmentStatus)
  status?: LeaveEncashmentStatus;
}
