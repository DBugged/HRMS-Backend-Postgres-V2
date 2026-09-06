import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
} from 'class-validator';
import { ReimbursementCategory } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// A sanity ceiling on a single claim (₹1 crore) — ported verbatim from the
// old controller. HR still reviews/approves every claim; this just stops an
// obviously fat-fingered or absurd amount from ever reaching that queue.
export const MAX_REIMBURSEMENT_AMOUNT = 10_000_000;

export class CreateReimbursementDto {
  @ApiPropertyOptional({ enum: ReimbursementCategory })
  @IsOptional()
  @IsEnum(ReimbursementCategory)
  category?: ReimbursementCategory;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  @Max(MAX_REIMBURSEMENT_AMOUNT)
  amount!: number;

  @ApiProperty({ example: '2026-06-10' })
  @IsValidCalendarDateString()
  claimDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiptUrl?: string;
}
