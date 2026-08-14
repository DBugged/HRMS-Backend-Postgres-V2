import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
} from 'class-validator';
import { ReimbursementCategory } from '@prisma/client';

// A sanity ceiling on a single claim (₹1 crore) — ported verbatim from the
// old controller. HR still reviews/approves every claim; this just stops an
// obviously fat-fingered or absurd amount from ever reaching that queue.
export const MAX_REIMBURSEMENT_AMOUNT = 10_000_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  @Matches(DATE_RE, { message: 'claimDate must be in YYYY-MM-DD format' })
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
