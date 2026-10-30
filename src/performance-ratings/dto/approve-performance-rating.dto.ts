import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

// HR/Admin approving a manager-submitted rating may optionally override the
// submitted rating before publishing (the payout follows it) — same optional-terms
// idiom as ApproveLoanDto.
export class ApprovePerformanceRatingDto {
  @ApiPropertyOptional({ description: '1-5, optional override' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  // Accepted from older clients but not used: the payout follows the (possibly overridden) rating.
  @ApiPropertyOptional({
    description: 'Ignored - the payout follows the rating (1: 0%, 2: 25%, 3: 50%, 4: 75%, 5: 100%).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  payoutPercentage?: number;
}
