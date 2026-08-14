import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { LoanStatus } from '@prisma/client';

const LOAN_STATUSES = [
  LoanStatus.ACTIVE,
  LoanStatus.CLOSED,
  LoanStatus.CANCELLED,
] as const;

export class UpdateLoanStatusDto {
  @ApiProperty({ enum: LOAN_STATUSES })
  @IsIn(LOAN_STATUSES)
  status!: LoanStatus;
}
