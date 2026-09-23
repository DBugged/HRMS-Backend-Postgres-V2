import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ReimbursementPaymentMode } from '@prisma/client';
import { REIMBURSEMENT_REVIEW_STATUSES } from './review-reimbursement.dto';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

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
