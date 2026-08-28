import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ReimbursementStatus } from '@prisma/client';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class QueryReimbursementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: ReimbursementStatus })
  @IsOptional()
  @IsEnum(ReimbursementStatus)
  status?: ReimbursementStatus;

  // Filters on claimDate, inclusive — lets the frontend pull one month's
  // claims at a time (or any custom range) instead of always loading the
  // organization's full reimbursement history.
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be in YYYY-MM-DD format' })
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be in YYYY-MM-DD format' })
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 200, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit: number = 200;
}
