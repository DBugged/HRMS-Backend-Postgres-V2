import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { ReimbursementPaymentMode } from '@prisma/client';
import { REIMBURSEMENT_REVIEW_STATUSES } from './review-reimbursement.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class BulkReviewReimbursementDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  ids!: string[];

  @ApiProperty({ enum: REIMBURSEMENT_REVIEW_STATUSES })
  @IsIn(REIMBURSEMENT_REVIEW_STATUSES)
  status!: (typeof REIMBURSEMENT_REVIEW_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewComments?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD — only used when status is PAID' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'paidDate must be in YYYY-MM-DD format' })
  paidDate?: string;

  @ApiPropertyOptional({ enum: ReimbursementPaymentMode })
  @IsOptional()
  @IsIn(Object.values(ReimbursementPaymentMode))
  paymentMode?: ReimbursementPaymentMode;
}
