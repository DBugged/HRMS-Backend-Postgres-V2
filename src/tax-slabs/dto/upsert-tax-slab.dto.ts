import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
} from 'class-validator';
import { TaxRegime } from '@prisma/client';

export class UpsertTaxSlabDto {
  @ApiProperty({ example: '2026-27' })
  @IsNotEmpty()
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
  slabs?: { from: number; to: number | null; rate: number }[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  standardDeduction?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  cessRate?: number;

  @ApiPropertyOptional({
    type: [Object],
    description: '[{from, to, rate}, ...] — surcharge on tax amount',
  })
  @IsOptional()
  @IsArray()
  surchargeSlabs?: { from: number; to: number | null; rate: number }[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  rebate87ALimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  rebate87AAmount?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
