import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { LoanType } from '@prisma/client';

// Self-service — the employee requesting for themselves, so no
// employeeId/interestRate/startMonth/startYear here (unlike
// CreateLoanDto): those are HR/Admin's call, set at approve() time.
export class RequestLoanDto {
  @ApiPropertyOptional({ enum: LoanType })
  @IsOptional()
  @IsEnum(LoanType)
  loanType?: LoanType;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  principal!: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  tenureMonths!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}
