import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { TaxRegime } from '@prisma/client';
import { IsFinancialYear } from '../../common/is-financial-year.validator';

// Upper bounds, so a typo cannot silently zero out (or double) everyone's TDS. All are generous against the real rules
// (standard deduction 75,000; 87A limit 12,00,000; cess 4%).
export const MAX_SLAB_BANDS = 20;

export class UpsertTaxSlabDto {
  @ApiProperty({ example: '2026-27' })
  @IsNotEmpty()
  @IsFinancialYear()
  financialYear!: string;

  @ApiProperty({ enum: TaxRegime })
  @IsEnum(TaxRegime)
  regime!: TaxRegime;

  @ApiPropertyOptional({
    type: [Object],
    description: '[{from, to, rate}, ...]',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SLAB_BANDS)
  slabs?: { from: number; to: number | null; rate: number }[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500000)
  standardDeduction?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  cessRate?: number;

  @ApiPropertyOptional({
    type: [Object],
    description: '[{from, to, rate}, ...] — surcharge on tax amount',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SLAB_BANDS)
  surchargeSlabs?: { from: number; to: number | null; rate: number }[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000000)
  rebate87ALimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000000)
  rebate87AAmount?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
