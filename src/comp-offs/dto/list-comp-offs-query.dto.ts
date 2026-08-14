import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { CompOffStatus } from '@prisma/client';

export class ListCompOffsQueryDto {
  @ApiPropertyOptional({
    description:
      'Ignored for EMPLOYEE/MANAGER callers (forced to self/department)',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: CompOffStatus })
  @IsOptional()
  @IsEnum(CompOffStatus)
  status?: CompOffStatus;
}
