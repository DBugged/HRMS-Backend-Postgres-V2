import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsInt,
  IsNumber,
  IsPositive,
  IsString,
  Max,
} from 'class-validator';
import { LoanType } from '@prisma/client';
import { MAX_LOAN_PRINCIPAL, MAX_LOAN_TENURE_MONTHS } from '../loan-limits';

// Self-service — the employee requesting for themselves, so no
// employeeId/interestRate/startMonth/startYear here (unlike
// CreateLoanDto): those are HR/Admin's call, set at approve() time.
export class RequestLoanDto {
  @ApiProperty({ enum: LoanType })
  @IsEnum(LoanType)
  loanType!: LoanType;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_LOAN_PRINCIPAL)
  principal!: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  @Max(MAX_LOAN_TENURE_MONTHS)
  tenureMonths!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Reason is required' })
  reason!: string;
}
