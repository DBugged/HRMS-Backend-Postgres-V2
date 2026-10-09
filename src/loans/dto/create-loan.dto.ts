import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { LoanType } from '@prisma/client';
import {
  MAX_LOAN_INTEREST_RATE,
  MAX_LOAN_PRINCIPAL,
  MAX_LOAN_TENURE_MONTHS,
} from '../loan-limits';

export class CreateLoanDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiPropertyOptional({ enum: LoanType })
  @IsOptional()
  @IsEnum(LoanType)
  loanType?: LoanType;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_LOAN_PRINCIPAL)
  principal!: number;

  @ApiPropertyOptional({ description: 'Annual %' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_LOAN_INTEREST_RATE)
  interestRate?: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  @Max(MAX_LOAN_TENURE_MONTHS)
  tenureMonths!: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(12)
  startMonth!: number;

  @ApiProperty()
  @IsInt()
  @Min(2000)
  @Max(2100)
  startYear!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}
