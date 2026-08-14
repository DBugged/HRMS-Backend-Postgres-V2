import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export const REIMBURSEMENT_REVIEW_STATUSES = [
  'APPROVED',
  'REJECTED',
  'PAID',
] as const;

export class ReviewReimbursementDto {
  @ApiPropertyOptional({ enum: REIMBURSEMENT_REVIEW_STATUSES })
  @IsIn(REIMBURSEMENT_REVIEW_STATUSES)
  status!: (typeof REIMBURSEMENT_REVIEW_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewComments?: string;
}
