import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ReimbursementStatus } from '@prisma/client';

export class QueryReimbursementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: ReimbursementStatus })
  @IsOptional()
  @IsEnum(ReimbursementStatus)
  status?: ReimbursementStatus;
}
