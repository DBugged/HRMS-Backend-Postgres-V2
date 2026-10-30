import { IsFinancialYear } from '../../common/is-financial-year.validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpsertPerformanceRatingDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiProperty({ example: '2026-27' })
  @IsNotEmpty()
  @IsString()
  @IsFinancialYear()
  financialYear!: string;

  @ApiProperty({ description: '1-5' })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  // Accepted from older clients but not used: the payout follows the rating (see rating-payout.ts).
  @ApiPropertyOptional({
    description: 'Ignored - the payout follows the rating (1: 0%, 2: 25%, 3: 50%, 4: 75%, 5: 100%).',
  })
  @IsOptional()
  @Min(0)
  @Max(200)
  payoutPercentage?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
