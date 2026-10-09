import { IsFinancialYear } from '../../common/is-financial-year.validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { PerformanceRatingStatus } from '@prisma/client';

export class QueryPerformanceRatingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsFinancialYear()
  financialYear?: string;

  @ApiPropertyOptional({ enum: PerformanceRatingStatus })
  @IsOptional()
  @IsEnum(PerformanceRatingStatus)
  status?: PerformanceRatingStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @ApiPropertyOptional({ default: 200, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit: number = 200;
}
