import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class QueryLeaveTrackerBalancesDto {
  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiPropertyOptional({
    description:
      'ADMIN/HR only — narrows to one department. Ignored (server-forced to their own) for MANAGER.',
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}
