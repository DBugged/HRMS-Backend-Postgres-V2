import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export const SETTLEMENT_PAYMENT_MODES = [
  'BANK_TRANSFER',
  'CHEQUE',
  'CASH',
  'UPI',
] as const;

// What HR records when the final payout actually goes out.
export class MarkSettlementPaidDto {
  @ApiPropertyOptional({
    example: '2026-11-03',
    description: 'Date the payment was made. Defaults to today.',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  paidOn?: string;

  @ApiPropertyOptional({ enum: SETTLEMENT_PAYMENT_MODES })
  @IsOptional()
  @IsIn(SETTLEMENT_PAYMENT_MODES)
  paymentMode?: (typeof SETTLEMENT_PAYMENT_MODES)[number];

  @ApiPropertyOptional({ description: 'UTR / cheque number / voucher no.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  paymentReference?: string;
}
