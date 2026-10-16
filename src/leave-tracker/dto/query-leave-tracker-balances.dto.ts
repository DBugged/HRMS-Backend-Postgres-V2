import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Matches,
} from 'class-validator';

export class QueryLeaveTrackerBalancesDto {
  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiPropertyOptional({
    description:
      'YYYY-MM. When given, balances are those of the leave year containing that month (the year field is then ignored), leave taken and WFH days are counted for that month only.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' })
  period?: string;

  @ApiPropertyOptional({
    description:
      'ADMIN/HR only — narrows to one department. Ignored (server-forced to their own) for MANAGER.',
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({
    description:
      'Leave balances only: skips the comp-off and work-from-home figures, which are the slowest part of the response. Used by the Employee Leave Stat page.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  lite?: boolean;
}
