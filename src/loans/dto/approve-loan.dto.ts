import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  Max,
  Min,
} from 'class-validator';

// HR/Admin fills in the terms a self-request never carries — interestRate
// defaults to 0% (an interest-free advance) and tenureMonths defaults to
// what the employee originally requested unless overridden here.
export class ApproveLoanDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(12)
  startMonth!: number;

  @ApiProperty()
  @IsInt()
  startYear!: number;

  @ApiPropertyOptional({ description: 'Annual %' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  interestRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  tenureMonths?: number;
}
