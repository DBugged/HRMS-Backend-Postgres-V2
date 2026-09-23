import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ReimbursementPaymentMode } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

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

  // Only meaningful when status is PAID — a free-form date so a payout that
  // happened on a different day than the approval (or was backdated) can be
  // recorded accurately. Defaults to today server-side if omitted.
  @ApiPropertyOptional({
    description: 'YYYY-MM-DD — only used when status is PAID',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  paidDate?: string;

  @ApiPropertyOptional({ enum: ReimbursementPaymentMode })
  @IsOptional()
  @IsIn(Object.values(ReimbursementPaymentMode))
  paymentMode?: ReimbursementPaymentMode;
}
